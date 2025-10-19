// SPDX-License-Identifier: CC0-1.0
// fair_token/src/lib.rs
#![allow(deprecated)]
#![allow(clippy::too_many_arguments)]
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_option::COption;
use anchor_lang::system_program; // so system_program::ID is in scope
use anchor_spl::token::{
    self, spl_token::instruction::AuthorityType, Burn, Mint, MintTo, SetAuthority, Token,
    TokenAccount, Transfer,
};

// ---------- Admin & Parameters ----------
//
// Parameters in this block are configurable for other projects.
declare_id!("EGxd8LCM8Y1uMyXrWWapEMh9tH2whZaNBYhaV29Mq9fb");
pub const ADMIN: Pubkey = pubkey!("7kj6VagrS2AdohX3nsSazdsdgj6d1Sqh1fJqZHLMi3sK");

// Pricing rule (fixed):
//  - 1 lamport == 1 base unit
//  - 1 token == 10^DECIMALS base units == 10^DECIMALS lamports
//    (e.g., DECIMALS=9 → 1 token = 1e9 lamports = 1 SOL)
//    (e.g., DECIMALS=8 → 1 token = 1e8 lamports = 0.1 SOL)
const DECIMALS: u8 = 9;

const MIN_SUPPLY_TOKENS: u64 = 100_000; // After initial sale, net circulating + vault >= this (in tokens)
const MIN_WINDOW: i64 = 45; // initial sale minimum days
const MAX_WINDOW: i64 = 90; // initial sale maximum days
                            // End configurable block
                            // ----------------------------------------------------------------

#[program]
pub mod fair_token {
    use super::*;

    /// Trustless, singleton initialize:
    /// - Only ADMIN may call
    /// - Accepts `sale_end` at runtime within [MIN_WINDOW, MAX_WINDOW]
    /// - Handoffs SPL mint authority from ADMIN to PDA `mint_authority`
    /// - Establishes SOL vault (System-owned PDA) and token vault (program-owned PDA)
    /// - Sets fixed price rule: 1 lamport == 1 base unit (see DECIMALS comment)
    pub fn initialize(ctx: Context<Initialize>, sale_end: i64) -> Result<()> {
        // ---- time window checks ----
        let now = Clock::get()?.unix_timestamp;
        let max_sale_end = now + 60 * 60 * 24 * MAX_WINDOW;
        let min_sale_end = now + 60 * 60 * 24 * MIN_WINDOW;
        require!(sale_end <= max_sale_end, ErrorCode::SaleEndNotInRange);
        require!(sale_end >= min_sale_end, ErrorCode::SaleEndNotInRange);

        // ---- constants / overflow guard ----
        let base_units_per_token: u64 = 10u64.pow(DECIMALS as u32);
        // Ensure MIN_SUPPLY_TOKENS * base_units_per_token won't overflow u64
        require!(
            MIN_SUPPLY_TOKENS <= u64::MAX / base_units_per_token,
            ErrorCode::MinSupplyTooLarge
        );

        // ---- one-time init guard (defense-in-depth) ----
        let config = &mut ctx.accounts.config;
        require!(!config.initialized, ErrorCode::AlreadyInitialized);

        // ─────────────────────────────────────────────────────────────────────
        // Mint authority handoff (admin -> PDA), then invariants
        // ─────────────────────────────────────────────────────────────────────
        let mint = &mut ctx.accounts.mint;
        let admin = &ctx.accounts.admin;
        let pda = ctx.accounts.mint_authority.key();

        // Pre-handoff checks (must currently be admin)
        require!(mint.freeze_authority.is_none(), ErrorCode::FreezeNotRevoked);
        require_eq!(mint.decimals, DECIMALS, ErrorCode::WrongDecimals);
        require_eq!(mint.supply, 0u64, ErrorCode::NonZeroInitialSupply);
        require!(
            matches!(mint.mint_authority, COption::Some(x) if x == admin.key()),
            ErrorCode::MintAuthorityMustBeAdmin
        );

        // Handoff: admin → PDA (atomic CPI)
        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            SetAuthority {
                account_or_mint: mint.to_account_info(),
                current_authority: admin.to_account_info(),
            },
        );
        token::set_authority(cpi_ctx, AuthorityType::MintTokens, Some(pda))?;

        // Confirm authority actually changed
        mint.reload()?;
        require!(
            matches!(mint.mint_authority, COption::Some(x) if x == pda),
            ErrorCode::WrongMintAuthority
        );

        // Anchor quirk: `SystemAccount<'info>` can't be directly created via CPI here,
        // so `sol_vault` is created as a raw AccountInfo and later used as SystemAccount
        // in buy/redeem. We enforce safety invariants now:
        //  - owner == System Program
        //  - data_len == 0 (no account data)
        let ai = &ctx.accounts.sol_vault;
        require_keys_eq!(*ai.owner, system_program::ID, ErrorCode::InvalidOwner);
        require!(ai.data_len() == 0, ErrorCode::NonZeroData);

        // ---- persist config ----
        config.initialized = true;
        config.finalized = false;
        config.mint = mint.key();
        config.sol_vault = ctx.accounts.sol_vault.key();
        config.token_vault = ctx.accounts.token_vault.key();
        config.token_vault_account = ctx.accounts.token_vault_account.key();
        config.sale_end = sale_end;
        config.total_burned = 0;
        // Safe mul: overflow-guarded above
        config.min_supply_base_units = MIN_SUPPLY_TOKENS * base_units_per_token;

        emit!(InitializedEvent {
            admin: ctx.accounts.admin.key(),
            mint: mint.key(),
            sol_vault: ctx.accounts.sol_vault.key(),
            token_vault: ctx.accounts.token_vault.key(),
            sale_end,
        });

        Ok(())
    }

    /// Buy during initial sale (pre-finalization) or from vault (post-finalization).
    ///  - Pre-finalization: mint `lamports_sent` base units to user (PDA mint authority).
    ///  - Post-finalization: transfer `lamports_sent` base units from vault to user.
    /// In both cases, SOL moves buyer → SOL vault, same amount as base units minted/transferred.
    pub fn buy_fair_token(ctx: Context<BuyFairToken>, lamports_sent: u64) -> Result<()> {
        require!(lamports_sent > 0, ErrorCode::NoSOLSent);
        require!(ctx.accounts.config.initialized, ErrorCode::NotInitialized);

        let sale_end = ctx.accounts.config.sale_end;
        let finalized = ctx.accounts.config.finalized;

        if !finalized {
            // Optional clarity check: mint authority is still the PDA
            require!(
                matches!(ctx.accounts.mint.mint_authority, COption::Some(x) if x == ctx.accounts.mint_authority.key()),
                ErrorCode::WrongMintAuthority
            );

            // pre-finalization: mint (1 lamport == 1 base unit)
            let seeds: &[&[u8]] = &[b"mint_authority", &[ctx.bumps.mint_authority]];
            let signer: &[&[&[u8]]] = &[seeds];
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.user_token_account.to_account_info(),
                    authority: ctx.accounts.mint_authority.to_account_info(),
                },
                signer,
            );
            token::mint_to(cpi_ctx, lamports_sent)?;
            emit!(BuyMintEvent {
                buyer: ctx.accounts.buyer.key(),
                amount: lamports_sent,
                lamports: lamports_sent, // amount == lamports (1:1 base units)
            });
        } else {
            // post-finalization: transfer from vault (1 lamport == 1 base unit)
            require!(
                ctx.accounts.token_vault_account.amount >= lamports_sent,
                ErrorCode::VaultInsufficient
            );
            let seeds: &[&[u8]] = &[b"token_vault", &[ctx.bumps.token_vault]];
            let signer: &[&[&[u8]]] = &[seeds];
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.token_vault_account.to_account_info(),
                    to: ctx.accounts.user_token_account.to_account_info(),
                    authority: ctx.accounts.token_vault.to_account_info(),
                },
                signer,
            );
            token::transfer(cpi_ctx, lamports_sent)?;
            emit!(BuyVaultEvent {
                buyer: ctx.accounts.buyer.key(),
                amount: lamports_sent,
                lamports: lamports_sent, // amount == lamports (1:1 base units)
                finalized,
            });
        }

        // buyer -> sol_vault (SOL)
        anchor_lang::solana_program::program::invoke(
            &anchor_lang::solana_program::system_instruction::transfer(
                &ctx.accounts.buyer.key(),
                &ctx.accounts.sol_vault.key(),
                lamports_sent,
            ),
            &[
                ctx.accounts.buyer.to_account_info(),
                ctx.accounts.sol_vault.to_account_info(),
            ],
        )?;

        // Auto-finalize trigger: only if not already finalized and now > sale_end
        let now = Clock::get()?.unix_timestamp;
        if !finalized && now > sale_end {
            finalize_sale(
                &mut ctx.accounts.config,
                &ctx.accounts.mint,
                ctx.accounts.mint_authority.to_account_info(),
                ctx.accounts.token_vault_account.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                ctx.bumps.mint_authority,
                lamports_sent,
                0,
            )?;
        }
        Ok(())
    }

    /// Redeem during initial sale (pre-finalization) or after (post-finalization).
    ///  - Pre-finalization: burn `amount_to_redeem` base units from user; pay same SOL from vault to redeemer.
    ///  - Post-finalization: transfer `amount_to_redeem` base units from user to vault; pay same SOL from vault.
    pub fn redeem_fair_token(ctx: Context<RedeemFairToken>, amount_to_redeem: u64) -> Result<()> {
        require!(ctx.accounts.config.initialized, ErrorCode::NotInitialized);
        require!(amount_to_redeem > 0, ErrorCode::ZeroTokenRedeem);
        require!(
            ctx.accounts.user_token_account.amount >= amount_to_redeem,
            ErrorCode::InsufficientTokens
        );
        require!(
            ctx.accounts.user_token_account.mint == ctx.accounts.mint.key(),
            ErrorCode::InvalidMint
        );
        require!(
            ctx.accounts.sol_vault.key() == ctx.accounts.config.sol_vault,
            ErrorCode::InvalidVault
        );
        require!(
            amount_to_redeem <= ctx.accounts.sol_vault.lamports(),
            ErrorCode::VaultSOLInsufficient
        );

        let sale_end = ctx.accounts.config.sale_end;
        let finalized = ctx.accounts.config.finalized;

        if !finalized {
            // burn redeemed tokens (1 lamport == 1 base unit)
            let cpi_ctx = CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.mint.to_account_info(),
                    from: ctx.accounts.user_token_account.to_account_info(),
                    authority: ctx.accounts.redeemer.to_account_info(),
                },
            );
            token::burn(cpi_ctx, amount_to_redeem)?;
            ctx.accounts.config.total_burned = ctx
                .accounts
                .config
                .total_burned
                .saturating_add(amount_to_redeem);

            emit!(RedeemBurnEvent {
                redeemer: ctx.accounts.redeemer.key(),
                amount: amount_to_redeem,
                lamports: amount_to_redeem, // amount == lamports (1:1 base units)
            });
        } else {
            // after finalization, transfer redeemed tokens back to vault (1:1 base units)
            let cpi_ctx = CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_token_account.to_account_info(),
                    to: ctx.accounts.token_vault_account.to_account_info(),
                    authority: ctx.accounts.redeemer.to_account_info(),
                },
            );
            token::transfer(cpi_ctx, amount_to_redeem)?;
            emit!(RedeemVaultEvent {
                redeemer: ctx.accounts.redeemer.key(),
                amount: amount_to_redeem,
                lamports: amount_to_redeem, // amount == lamports (1:1 base units)
            });
        }

        // SOL: transfer from SOL vault PDA → redeemer, authorized by PDA seeds
        {
            let vault_ai = ctx.accounts.sol_vault.to_account_info();
            let redeemer_ai = ctx.accounts.redeemer.to_account_info();

            let bump = ctx.bumps.sol_vault;
            let seeds_arr: [&[u8]; 2] = [b"sol_vault", &[bump]];
            let signer_seeds: &[&[u8]] = &seeds_arr;
            let signers: &[&[&[u8]]] = &[signer_seeds];

            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: vault_ai,
                    to: redeemer_ai,
                },
                signers,
            );
            system_program::transfer(cpi_ctx, amount_to_redeem)?;
        }

        // Auto-finalize if crossed sale_end
        let now = Clock::get()?.unix_timestamp;
        if !finalized && now > sale_end {
            finalize_sale(
                &mut ctx.accounts.config,
                &ctx.accounts.mint,
                ctx.accounts.mint_authority.to_account_info(),
                ctx.accounts.token_vault_account.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                ctx.bumps.mint_authority,
                0,
                amount_to_redeem,
            )?;
        }
        Ok(())
    }
}

fn finalize_sale<'info>(
    // Finalize the initial sale period. This function may be called inside a buy/redeem
    // that happens after sale_end. Since `mint.supply` doesn't include the current tx's
    // mint/burn effects yet, we pass `bought_this_transaction` and `redeemed_this_transaction`
    // to compute the shortfall properly.
    config: &mut Account<'info, Config>,
    mint: &Account<'info, Mint>,
    mint_authority: AccountInfo<'info>,
    token_vault_account: AccountInfo<'info>,
    token_program: AccountInfo<'info>,
    bump: u8,
    bought_this_transaction: u64,
    redeemed_this_transaction: u64,
) -> Result<()> {
    if config.finalized {
        return Ok(());
    }

    // Calculate shortfall to meet min_supply, correcting for this tx’s net effect.
    let net_minted: i128 = (config.min_supply_base_units as i128)
        - (mint.supply as i128)
        - (bought_this_transaction as i128)
        + (redeemed_this_transaction as i128);

    let to_be_minted: u64 = if net_minted > 0 { net_minted as u64 } else { 0 };

    // PDA signer seeds
    let signer_seeds: &[&[u8]] = &[b"mint_authority", &[bump]];
    let signer: &[&[&[u8]]] = &[signer_seeds];

    if to_be_minted > 0 {
        // Mint shortfall into the vault (authority is the PDA)
        let mint_to_accounts = MintTo {
            mint: mint.to_account_info(),
            to: token_vault_account.clone(),
            authority: mint_authority.clone(),
        };
        let cpi = CpiContext::new_with_signer(token_program.clone(), mint_to_accounts, signer);
        token::mint_to(cpi, to_be_minted)?;

        emit!(MinimumEnforcedEvent {
            forced_minted: to_be_minted
        });
    }

    // Revoke MintTokens authority: PDA -> None (finalize)
    let set_auth_accounts = SetAuthority {
        account_or_mint: mint.to_account_info(),
        current_authority: mint_authority.clone(),
    };
    let cpi = CpiContext::new_with_signer(token_program, set_auth_accounts, signer);
    token::set_authority(cpi, AuthorityType::MintTokens, None)?;

    // Mark finalized and emit supply after including the shortfall minted just now.
    // (No reload needed; we intentionally use pre-mint supply + to_be_minted.)
    config.finalized = true;
    emit!(SaleFinalizedEvent {
        total_supply: mint.supply.saturating_add(to_be_minted)
    });

    Ok(())
}

// ------------------------- Accounts -------------------------

#[derive(Accounts)]
pub struct Initialize<'info> {
    /// Admin signer (hard-gated; remove `address=ADMIN` if you don't want gating)
    #[account(mut, address = ADMIN)]
    pub admin: Signer<'info>,

    /// Pre-created SPL mint (vanity). Must be: decimals=DECIMALS, freeze=None, supply=0, mint_authority=admin.
    /// We will handoff authority to the PDA inside this instruction.
    #[account(
        mut,
        constraint = mint.decimals == DECIMALS                 @ ErrorCode::WrongDecimals,
        constraint = mint.freeze_authority.is_none()           @ ErrorCode::FreezeNotRevoked,
        constraint = mint.supply == 0                          @ ErrorCode::NonZeroInitialSupply,
        constraint = mint.mint_authority == Some(admin.key()).into() @ ErrorCode::MintAuthorityMustBeAdmin,
    )]
    pub mint: Account<'info, Mint>,

    /// CHECK: PDA that will become the new mint authority (no data needed).
    #[account(
        seeds = [b"mint_authority"],
        bump
    )]
    pub mint_authority: AccountInfo<'info>,

    /// Global singleton config PDA
    #[account(
        init,
        payer = admin,
        space = 8 + Config::SIZE,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,

    /// CHECK: System-owned, zero-data PDA used as a SOL vault.
    /// Using AccountInfo to avoid Anchor's SystemAccount "try_from_unchecked" quirk during init.
    #[account(
        init,
        payer = admin,
        space = 0,
        owner = system_program::ID,
        seeds = [b"sol_vault"],
        bump
    )]
    pub sol_vault: AccountInfo<'info>,

    /// Program-owned marker PDA for token vault state
    #[account(
        init,
        payer = admin,
        space = 8 + TokenVault::SIZE,
        seeds = [b"token_vault"],
        bump
    )]
    pub token_vault: Account<'info, TokenVault>,

    /// SPL token account controlled by `token_vault` PDA
    #[account(
        init,
        payer = admin,
        token::mint = mint,
        token::authority = token_vault
    )]
    pub token_vault_account: Account<'info, TokenAccount>,

    /// Canonical programs
    #[account(address = token::ID)]
    pub token_program: Program<'info, Token>,
    #[account(address = system_program::ID)]
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BuyFairToken<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(mut)]
    pub mint: Account<'info, Mint>,

    /// CHECK: PDA signer derived from static seed; no deserialization needed
    #[account(seeds = [b"mint_authority"], bump)]
    pub mint_authority: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [b"config"],
        bump,
        has_one = mint @ ErrorCode::WrongMint,
        has_one = sol_vault @ ErrorCode::WrongSolVault,
        has_one = token_vault @ ErrorCode::WrongTokenVault,
        has_one = token_vault_account @ ErrorCode::WrongTokenVaultAccount,
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [b"sol_vault"],
        bump
    )]
    pub sol_vault: SystemAccount<'info>,

    #[account(mut, seeds = [b"token_vault"], bump)]
    pub token_vault: Account<'info, TokenVault>,

    #[account(
        mut,
        constraint = token_vault_account.mint == mint.key()             @ ErrorCode::WrongMint,
        constraint = token_vault_account.owner == token_vault.key()     @ ErrorCode::WrongVaultAuthority,
    )]
    pub token_vault_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_token_account.mint == mint.key(),
        constraint = user_token_account.owner == buyer.key(),
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(address = token::ID)]
    pub token_program: Program<'info, Token>,
    #[account(address = system_program::ID)]
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RedeemFairToken<'info> {
    #[account(mut)]
    pub redeemer: Signer<'info>,

    #[account(mut)]
    pub mint: Account<'info, Mint>,

    /// CHECK: PDA signer derived from static seed; no deserialization needed
    #[account(seeds = [b"mint_authority"], bump)]
    pub mint_authority: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [b"config"],
        bump,
        has_one = mint @ ErrorCode::WrongMint,
        has_one = sol_vault @ ErrorCode::WrongSolVault,
        has_one = token_vault @ ErrorCode::WrongTokenVault,
        has_one = token_vault_account @ ErrorCode::WrongTokenVaultAccount,
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [b"sol_vault"],
        bump
    )]
    pub sol_vault: SystemAccount<'info>,

    #[account(mut, seeds = [b"token_vault"], bump)]
    pub token_vault: Account<'info, TokenVault>,

    #[account(
        mut,
        constraint = token_vault_account.mint == mint.key()             @ ErrorCode::WrongMint,
        constraint = token_vault_account.owner == token_vault.key()     @ ErrorCode::WrongVaultAuthority,
    )]
    pub token_vault_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_token_account.mint == mint.key(),
        constraint = user_token_account.owner == redeemer.key(),
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(address = token::ID)]
    pub token_program: Program<'info, Token>,
    #[account(address = system_program::ID)]
    pub system_program: Program<'info, System>,
}

// ------------------------- Data Accounts -------------------------

#[account]
pub struct TokenVault {
    _dummy: u8,
}
impl TokenVault {
    pub const SIZE: usize = 1;
}

#[account]
pub struct Config {
    pub initialized: bool,
    pub finalized: bool,
    pub mint: Pubkey,
    pub sol_vault: Pubkey,
    pub token_vault: Pubkey,
    pub token_vault_account: Pubkey,
    pub sale_end: i64,
    pub min_supply_base_units: u64,
    pub total_burned: u64, // informational; not used in logic
}
impl Config {
    pub const SIZE: usize = 1 + 1 + 32 + 32 + 32 + 32 + 8 + 8 + 8; // 154
}

// ------------------------- Events -------------------------

#[event]
pub struct InitializedEvent {
    pub admin: Pubkey,
    pub mint: Pubkey,
    pub sol_vault: Pubkey,
    pub token_vault: Pubkey,
    pub sale_end: i64,
}

#[event]
pub struct BuyMintEvent {
    pub buyer: Pubkey,
    pub amount: u64,   // base units minted
    pub lamports: u64, // NOTE: amount == lamports (1:1 base units)
}

#[event]
pub struct BuyVaultEvent {
    pub buyer: Pubkey,
    pub amount: u64,   // base units transferred from vault
    pub lamports: u64, // NOTE: amount == lamports (1:1 base units)
    pub finalized: bool,
}

#[event]
pub struct RedeemBurnEvent {
    pub redeemer: Pubkey,
    pub amount: u64,   // base units burned
    pub lamports: u64, // NOTE: amount == lamports (1:1 base units)
}

#[event]
pub struct RedeemVaultEvent {
    pub redeemer: Pubkey,
    pub amount: u64,   // base units moved to vault
    pub lamports: u64, // NOTE: amount == lamports (1:1 base units)
}

#[event]
pub struct SaleFinalizedEvent {
    pub total_supply: u64, // post-finalization supply (pre + shortfall)
}

#[event]
pub struct MinimumEnforcedEvent {
    pub forced_minted: u64, // base units minted to meet min_supply
}

// ------------------------- Errors -------------------------

#[error_code]
pub enum ErrorCode {
    #[msg("Already initialized.")]
    AlreadyInitialized,

    #[msg("Sale end not in the allowed range.")]
    SaleEndNotInRange,

    #[msg("Minimum supply is too large.")]
    MinSupplyTooLarge,

    #[msg("Mint has no mint authority set.")]
    MintAuthorityMissing,

    #[msg("Mint authority does not match the program's PDA.")]
    WrongMintAuthority,

    #[msg("Freeze authority must be revoked (None) before initialization.")]
    FreezeNotRevoked,

    #[msg("Mint has unexpected decimals.")]
    WrongDecimals,

    #[msg("Mint has non-zero supply at initialization.")]
    NonZeroInitialSupply,

    #[msg("Account owner must be System Program.")]
    InvalidOwner,

    #[msg("Account must have zero data length.")]
    NonZeroData,

    #[msg("Wrong mint passed.")]
    WrongMint,

    #[msg("Wrong SOL vault for this config.")]
    WrongSolVault,

    #[msg("Mint authority must be admin.")]
    MintAuthorityMustBeAdmin,

    #[msg("No SOL sent.")]
    NoSOLSent,

    #[msg("Insufficient tokens available in vault.")]
    VaultInsufficient,

    #[msg("Zero token redeem.")]
    ZeroTokenRedeem,

    #[msg("Insufficient FairToken tokens.")]
    InsufficientTokens,

    #[msg("Not enough SOL in vault.")]
    VaultSOLInsufficient,

    #[msg("Invalid mint.")]
    InvalidMint,

    #[msg("Invalid SOL vault address.")]
    InvalidVault,

    #[msg("Not initialized.")]
    NotInitialized,

    #[msg("Wrong token vault account for this config.")]
    WrongTokenVaultAccount,

    #[msg("Token vault does not own token vault account.")]
    WrongVaultAuthority,

    #[msg("Wrong token vault for this config.")]
    WrongTokenVault,
}
