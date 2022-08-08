use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_option::COption;
use anchor_spl::token::{self, Mint, TokenAccount, Token};
use anchor_lang::solana_program::native_token::LAMPORTS_PER_SOL;

declare_id!("8SxMuTujbukR6KbqJXUuVAdTg6kBWtpmCTb6xpYWqwrP");
pub const FCTR: u64 = 1_000_000_000_000;
pub const BCDEV: u64 = 1_000_000_000_000_000_000;
pub const ACCURACY: u64 = 100_000;


#[program]
pub mod fctr_staking {
    use super::*;    
    
    // Initialize stake registrar
    #[access_control(Initialize::accounts(&ctx, nonce))]
    pub fn initialize(
        ctx: Context<Initialize>,      
        _bump: u8,
        mint: Pubkey,
        authority: Pubkey,
        nonce: u8,
        round_timelock: i64,              
    ) -> Result<()> {

        // Create registrar struct
        let registrar = &mut ctx.accounts.registrar;
        registrar.authority = authority;
        registrar.nonce = nonce;
        registrar.finalized = false;        
        registrar.mint = mint;
        registrar.pool_mint = *ctx.accounts.pool_mint.to_account_info().key;  
        registrar.round_timelock = round_timelock;
        registrar.current_round=0;
        registrar.current_round_account=None;      
        
        Ok(())
    }
   
    // Initialize member struct
    #[access_control(CreateMember::accounts(&ctx, nonce))]
    pub fn create_member(ctx: Context<CreateMember>, nonce: u8, partisipate_sharing: bool) -> Result<()> {
        
        // Create member of staking struct
        let member = &mut ctx.accounts.member;
        member.registrar = *ctx.accounts.registrar.to_account_info().key;
        member.beneficiary = *ctx.accounts.beneficiary.key;
        member.bought =0;
        member.trusted =0;
        member.shared = 0;    
        member.staked =0;
        member.staked_trusted=0;
        member.staked_round = None;
        member.reward = 0;     
        member.unstaked = false;
        member.reward = 0;
        member.dont_participate_sharing = partisipate_sharing; 
        member.nonce = nonce;                
        member.trusted_pool=vec![];

        Ok(())
    }

    // Buy FCTR tokens
    pub fn buy_fctr(ctx: Context<BuyFctr>, amount: u64) -> Result<()> {

        // Check that member doesn't have trusters
        require!(
            ctx.accounts.member.trusted_pool.len()==0,
            ErrorCode::CantBuyOfSharing,
        );

        // Check that member didn't shared
        require!(
            ctx.accounts.member.shared==0,
            ErrorCode::CantBuyOfSharing,
        );        
        
        //Check that  amount is more then 10 tokens        
        require!(amount >= 10*FCTR, ErrorCode::AmountTooSmall);       
        
        // Calculate lamports amount for requested tokens
        let sol_amount= curency_to_sol_in_lamports(&amount,&FCTR,&109);   
        msg!("Sol amount for {} FCTR is {}",amount,sol_amount);
        
        //Check that buyer has enouph lamports for transfer  
        if **ctx.accounts.buyer.try_borrow_lamports()? < sol_amount  {
            return Err(error!(ErrorCode::InsufficientFundsForTransaction));
        }
        
        //Transfer lamports amount to registrar
        let ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.buyer.key(),
            &ctx.accounts.vault_sol_account.key(),
            sol_amount,
        );
        anchor_lang::solana_program::program::invoke(
            &ix,
            &[
                ctx.accounts.buyer.to_account_info(),
                ctx.accounts.vault_sol_account.to_account_info(),
            ],
        )?;          
        
        // Mint FCTR tokens amount to the buyer
        {
            let seeds = &[
                ctx.accounts.registrar.to_account_info().key.as_ref(),
                &[ctx.accounts.registrar.nonce],
            ];
            let registrar_signer = &[&seeds[..]];

            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info().clone(),
                token::MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.registrar_signer.to_account_info(),
                },
                registrar_signer,
            );
            token::mint_to(cpi_ctx, amount)?;
        }

        // Increase member bought counter for token amount
        ctx.accounts.member.bought+=amount;
        
        Ok(())
    }        
    
    // Transfer FCTR tokens without sharing 
    pub fn transfer_fctr(ctx: Context<TransferFctr>, amount: u64) -> Result<()> {
                
        //Check that user have enouph tokens for transfer
        require!(ctx.accounts.vault_fctr.amount >= amount, ErrorCode::InsuficientUserFunds);
        
        //Check that user have enouph tokens for transfer
        require!(ctx.accounts.member.bought - ctx.accounts.member.shared >= amount, ErrorCode::TransferOnlyBought);
               
        // Transfer tokens to another token holder.
        {
            let seeds = &[
                ctx.accounts.registrar.to_account_info().key.as_ref(),
                ctx.accounts.member.to_account_info().key.as_ref(),
                &[ctx.accounts.member.nonce],
            ];
            let member_signer = &[&seeds[..]];
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info().clone(),
                token::Transfer {
                    from: ctx.accounts.vault_fctr.to_account_info(),
                    to: ctx.accounts.token_holder.to_account_info(),
                    authority: ctx.accounts.member_signer.to_account_info(),
                },
                member_signer,
            );
             token::transfer(cpi_ctx, amount)?;
        }
        // Deccrease member bought counter
        ctx.accounts.member.bought -= amount;    
        
        Ok(())
    }    

    // Sell some BCDEV amount
    pub fn sell_bcdev(ctx: Context<SellBcdev>, amount: u64) -> Result<()> {
        
        // Check that user have enouph tokens for transfer
        require!(ctx.accounts.vault_bcdev.amount >= amount, ErrorCode::InsuficientUserFunds);
        
        // Calculate lamports amount for BCDEV tokens amount
        let sol_amount= curency_to_sol_in_lamports(&amount,&BCDEV,&11);   
        msg!("Sol amount for {} BCDEV is {}",amount,sol_amount);        
        
        //Check that vault has enouph lamports for transfer  
        if **ctx.accounts.vault_sol_account.try_borrow_lamports()? < sol_amount  {
            return Err(error!(ErrorCode::InsufficientFundsForTransaction));
        }     
   
        // Transfer lamports to member
        **ctx.accounts.vault_sol_account.try_borrow_mut_lamports()? -= sol_amount ;
        **ctx.accounts.beneficiary.try_borrow_mut_lamports()? += sol_amount ;  
        
        // Burn seller BCDEV tokens        
        let seeds = &[
                ctx.accounts.registrar.to_account_info().key.as_ref(),
                ctx.accounts.member.to_account_info().key.as_ref(),
                &[ctx.accounts.member.nonce],
            ];
            let member_signer = &[&seeds[..]];        
        {
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info().clone(),
                token::Burn {
                    mint: ctx.accounts.pool_mint.to_account_info(),
                    from: ctx.accounts.vault_bcdev.to_account_info(),
                    authority: ctx.accounts.member_signer.to_account_info(),
                },
                member_signer,
            );
            token::burn(cpi_ctx, amount)?;
        }       
        
        Ok(())
    }
    
    // Sell all FCTR tokens
    pub fn sell_all_fctr(ctx: Context<SellFctr>) -> Result<()> {

            // Check that member has no trusters
        require!(
            ctx.accounts.member.trusted_pool.len()==0,
            ErrorCode::CantBuyOfSharing,
        );
        
        // Check that member didn't share
        require!(
            ctx.accounts.member.shared==0,
            ErrorCode::CantBuyOfSharing,
        );
        
        // Get having amount of tokens   
        let amount = ctx.accounts.member.bought;
        
        // Calculate lamports amount for tokens
        let sol_amount= curency_to_sol_in_lamports(&amount,&FCTR,&101);   
        msg!("Sol amount for {} FCTR is {}",amount,sol_amount);        
        
        // Check that vault has enouph lamports for transfer  
        if **ctx.accounts.vault_sol_account.try_borrow_lamports()? < sol_amount  {
            return Err(error!(ErrorCode::InsufficientFundsForTransaction));
        }
        
        // Transfer amount to member
        **ctx.accounts.vault_sol_account.try_borrow_mut_lamports()? -= sol_amount ;
        **ctx.accounts.beneficiary.try_borrow_mut_lamports()? += sol_amount ;  
        
        // Burn seller FCTR tokens         
        let seeds = &[
                ctx.accounts.registrar.to_account_info().key.as_ref(),
                ctx.accounts.member.to_account_info().key.as_ref(),
                &[ctx.accounts.member.nonce],
            ];
            let member_signer = &[&seeds[..]];

        // Burn pool tokens.
        {
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info().clone(),
                token::Burn {
                    mint: ctx.accounts.mint.to_account_info(),
                    from: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.member_signer.to_account_info(),
                },
                member_signer,
            );
            token::burn(cpi_ctx, amount)?;
        }       

        // Zero having amount of tokens        
        ctx.accounts.member.bought=0;
        
        Ok(())
    }
    
    // Start new staking round
    pub fn start_round(
        ctx: Context<StartRound>,
        // Mark round as final
        final_round: bool, 
    ) -> Result<()> {

        // Check that round is not finalized  
        require!(!ctx.accounts.registrar.finalized, ErrorCode::StakingFinalized);
        
        // Create round struct
        let round = &mut ctx.accounts.round;
        round.registrar = *ctx.accounts.registrar.to_account_info().key;
        round.start_ts=ctx.accounts.clock.unix_timestamp;
        round.stop_ts=ctx.accounts.clock.unix_timestamp +
            ctx.accounts.registrar.round_timelock;
        round.number=ctx.accounts.registrar.current_round + 1;
        round.final_round=final_round;

        // Change registrar round fields
        ctx.accounts.registrar.current_round+=1;
        ctx.accounts.registrar.current_round_account=Some(round.key());
        ctx.accounts.registrar.finalized=final_round;
                
        //Emit round start event
        emit!(RoundEventLog {
            round: *ctx.accounts.round.to_account_info().key,
            ts: ctx.accounts.clock.unix_timestamp,            
        });
        
        Ok(())
    }
    
    // Stake to the round by member
    pub fn stake( ctx: Context<Stake>) -> Result<()> {

        //Check that member is staking to current round
        require!(
            ctx.accounts.registrar.current_round ==
                ctx.accounts.round.number,
            ErrorCode::StakingNotToCurrentRound
        );
        
        //Check that current round still goes on
        require!(
            ctx.accounts.round.stop_ts >
                ctx.accounts.clock.unix_timestamp,
            ErrorCode::RoundTimeIsOverStaking
        );
        
        // Check member has tokens
        require!(ctx.accounts.member.bought > 0 ,
            ErrorCode::NotEnouphForStake,            
        );
        
        // Get free tokens amount
        let token_amount = ctx.accounts.member.bought - ctx.accounts.member.shared +
                    ctx.accounts.member.trusted;        

        // Transfer tokens into the registrar stake vault.
        {
            let seeds = &[
                ctx.accounts.registrar.to_account_info().key.as_ref(),
                ctx.accounts.member.to_account_info().key.as_ref(),
                &[ctx.accounts.member.nonce],
            ];
            let member_signer = &[&seeds[..]];
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info().clone(),
                token::Transfer {
                    from: ctx.accounts.member_fctr_vault.to_account_info(),
                    to: ctx.accounts.registrar_vault.to_account_info(),
                    authority: ctx.accounts.member_signer.to_account_info(),
                },
                member_signer,
            );    
             token::transfer(cpi_ctx, token_amount)?;
        }       

        //Calculate time for what current stake would be
        let staked_time = ctx.accounts.round.stop_ts - ctx.accounts.clock.unix_timestamp;
                
        //Add 2 percents multiplied 100000 for each truster to APR
        let mut add_apr = 0;
        for _ in ctx.accounts.member.trusted_pool.iter(){
            add_apr+=2 * ACCURACY;
        }
        
        // Calculate increase of base APR in % multiplied 100000 for member who trust his tokens
        let x_apr: u64;
        if ctx.accounts.member.shared == 0 {
            // 1% * 100000 if not shared
            x_apr = 100_000;
        } else {
            // Or calculated in percents * 100000
            x_apr = part_calculation_x10_5(
                &(ctx.accounts.member.bought + ctx.accounts.member.trusted -ctx.accounts.member.shared),
                &ctx.accounts.member.shared,
                &ACCURACY
            );         
        }        
        msg!("apr {} with add {}",x_apr, add_apr);

        //Calculate stake pool tokens amount for the calculated time with calculated percents
        let spt_amount = apr_calculation (
            &token_amount,            
            &(x_apr  + add_apr), 
            &ctx.accounts.registrar.round_timelock,
            &staked_time,
        );
        msg!("spt_amount {}",spt_amount);        
        
        msg!("{} % part for {} FCTR is {} BCDEV",staked_time as f64 /ctx.accounts.registrar.round_timelock as f64, token_amount, spt_amount);
    
        //Increase stake value for member
        ctx.accounts.member.staked += ctx.accounts.member.bought - ctx.accounts.member.shared;

        //Increase trusted stake value for member
        ctx.accounts.member.staked_trusted += ctx.accounts.member.trusted;
        
        //Null the member legitim amount to prevent double staking
        ctx.accounts.member.bought = 0;
        ctx.accounts.member.trusted = 0;
        
        // Increase APR reward with calculated amount
        ctx.accounts.member.reward += spt_amount; 

        // Mark member stake status and staked round      
        ctx.accounts.member.unstaked = false;
        ctx.accounts.member.staked_round = Some(ctx.accounts.round.key());
        
        Ok(())
    }

    // Unstake from round
    pub fn unstake<'info>( ctx: Context<'_,'_,'_, 'info, Unstake<'info>>) -> Result<()> {
        
        // Check that unstake is made after the end of stake round
        require!(
            ctx.accounts.registrar.current_round >
                ctx.accounts.round.number,
            ErrorCode::EarlyUnstaking
        );

        // Check that round is already ended
        require!(
            ctx.accounts.round.stop_ts <
                ctx.accounts.clock.unix_timestamp,
            ErrorCode::RoundTimeIsOverUnstaking
        );

        // Check that member staked amount
        require!(ctx.accounts.member.staked > 0 ,
            ErrorCode::DidntStakedAnything,            
        );

        // Get number of members staked tokens
        let token_amount = ctx.accounts.member.staked;        
        
        // Calculate registrar sign
        let seeds = &[
            ctx.accounts.registrar.to_account_info().key.as_ref(),
            &[ctx.accounts.registrar.nonce],
        ];
        let registrar_signer = &[&seeds[..]];

        // Transfer tokens back to member who unstaked
        {            
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info().clone(),
                token::Transfer {
                    from: ctx.accounts.registrar_vault.to_account_info(),
                    to: ctx.accounts.member_fctr_vault.to_account_info(),
                    authority: ctx.accounts.registrar_signer.to_account_info(),
                },
                registrar_signer,
            );            
            token::transfer(cpi_ctx, token_amount)?;
        }       
        
        // Calculate 50% of reward for member if he trusted
        let spt_amount_member: u64;
        if ctx.accounts.member.trusted_pool.len()>0 {
                spt_amount_member = ctx.accounts.member.reward/2;
        } else {
            spt_amount_member = ctx.accounts.member.reward
        }
        
        // Mint pool tokens to the staker.
        {          
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info().clone(),
                token::MintTo {
                    mint: ctx.accounts.pool_mint.to_account_info(),
                    to: ctx.accounts.member_bcdev_vault.to_account_info(),
                    authority: ctx.accounts.registrar_signer.to_account_info(),
                },
                registrar_signer,
            );
            token::mint_to(cpi_ctx, spt_amount_member)?;
        }                
        
        //Check that member has trusters for stake
        if ctx.accounts.member.trusted_pool.len() > 0 {

            //Check the provided remaining account for unstake and reward for trusters
            let provided_remaining_accounts = &mut ctx.remaining_accounts.iter();

            //Check that number of provide accounts leads to trusters number
            require!(
                provided_remaining_accounts.len()==
                    ctx.accounts.member.trusted_pool.len()*2,
                ErrorCode::LowRemainingAccountsProvided
            );                       
            
            // Calculate and distribute stake and APR with trusters
            // Calculate and distribute stake
            let spt_amount_trusters = ctx.accounts.member.reward - spt_amount_member;
            msg!("spt_amount_trusters {}",spt_amount_trusters);
            
            // Calculate total stake for trasters
            let total = ctx.accounts.member.staked_trusted;
            msg!("total {}",total);

            // Calculate parts for each truster
            let mut spt_part: u64;
            let mut i=0;
            while i < ctx.remaining_accounts.len() {

                // Deserealize pairs of remaining accounts 
                let vault_fctr = next_account_info(provided_remaining_accounts)?;
                let vault_bcdev = next_account_info(provided_remaining_accounts)?;
 
                //Check that accounts are spl-tokens
                require!(vault_fctr.owner== &token::ID, ErrorCode::VaultWrongOwner);
                require!(vault_bcdev.owner== &token::ID, ErrorCode::VaultWrongOwner);

                // Check that accounts are equal to saved in Member struct
                require!(vault_fctr.key== &ctx.accounts.member.trusted_pool[i/2].fctr, ErrorCode::VaultWrongKey);
                require!(vault_bcdev.key== &ctx.accounts.member.trusted_pool[i/2].bcdev, ErrorCode::VaultWrongKey);
                
                // Transfer FCTR back to truster
                {
                    let cpi_ctx = CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info().clone(),
                        token::Transfer {
                            from: ctx.accounts.registrar_vault.to_account_info(),
                            to: ctx.remaining_accounts[i].to_account_info(),
                            authority: ctx.accounts.registrar_signer.to_account_info(),
                        },
                        registrar_signer,
                    );                    
                    token::transfer(cpi_ctx, ctx.accounts.member.trusted_pool[i/2].trusted_amount)?;
                }

                // Calculate reward multiplied 100000 part for truster
                spt_part =  part_calculation_x10_5 (
                    &ctx.accounts.member.trusted_pool[i/2].trusted_amount,
                    &total,
                    &ACCURACY,
                );                
                
                msg!("spt_part {}", spt_part);

                //Reduce spt for 5 numbers accuracy after point
                let spt_reduced = spt_amount_trusters/ACCURACY;

                msg!("spt_reduced {}", spt_reduced);                
                msg!("spt_amount_trusters {}", spt_amount_trusters);
                msg!("amount to mint {}", spt_part * spt_reduced);                
                
                // Mint pool tokens to the truster.
                {          
                    let cpi_ctx = CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info().clone(),
                        token::MintTo {
                            mint: ctx.accounts.pool_mint.to_account_info(),
                            to: ctx.remaining_accounts[i+1].to_account_info(),
                            authority: ctx.accounts.registrar_signer.to_account_info(),
                        },
                        registrar_signer,
                    );
                    token::mint_to(cpi_ctx, spt_part * spt_reduced)?;                    
                }
                               
                // Zero truster stake amount
                ctx.accounts.member.trusted_pool[i/2].trusted_amount=0;  
            
                //Iterate over trusters remaining_accounts                
                i+=2;                
            }                    
        }

        // Zero members reward
        ctx.accounts.member.reward = 0;
        // Restore members bought amount
        ctx.accounts.member.bought = token_amount;
        // Zero member trusters pool
        ctx.accounts.member.trusted_pool = vec![];
        // Zero staking counters
        ctx.accounts.member.trusted = 0;
        ctx.accounts.member.staked = 0;
        ctx.accounts.member.staked_trusted = 0;
        // Mark member as unstaked
        ctx.accounts.member.unstaked = true;    
        
        //Emit reward event
        emit!(RewardEventLog {
            member: *ctx.accounts.member.to_account_info().key,
            ts: ctx.accounts.clock.unix_timestamp, 
        });
                
        Ok(())
    }

    // Trust some amount to stake member
    pub fn trust_to_member( ctx: Context<TrustToMember>,amount:u64) -> Result<()> {
    
        // Check participating in sharing programm flag 
        require!(
            !ctx.accounts.member_to_trust.dont_participate_sharing,
            ErrorCode::MemberDontParticipateSharing
        );

        // Check that member shares less then once in 30 times round periods
        require!(
            ctx.accounts.clock.unix_timestamp -
                ctx.accounts.truster_to_member.last_time_trusted >                
                ctx.accounts.registrar.round_timelock * 30,
            ErrorCode::OftenSharingParticipation
        );
        
        // Sharing only bought tokens
        require!(
            amount < ctx.accounts.member_who_trust.bought,
            ErrorCode::ShareOnlyBought
        );
        
        //Check that user has les then four trusters
        require!(
            ctx.accounts.member_to_trust.trusted_pool.len() < 4,
            ErrorCode::MemberTrustersAmountExceeded
        );

        // Sharing amount must be less then the half of having
        require!(
            amount < (ctx.accounts.member_who_trust.bought - ctx.accounts.member_who_trust.shared + ctx.accounts.member_who_trust.trusted)/2,
            ErrorCode::AmountMoreThenHalf
        );

        // Sharing amount must be less quater of bought 
        require!(
             (ctx.accounts.member_who_trust.bought -ctx.accounts.member_who_trust.shared + ctx.accounts.member_who_trust.trusted) - amount > ctx.accounts.member_who_trust.bought/4,
             ErrorCode::AmountLesThenQuater
        );                
        
        //Sharing or shared member must be between half and double of self deposit
        let mut who = 0;
        let mut to = 0;
        
        // Set amount for staked or unstaked status
        if ctx.accounts.member_who_trust.bought != 0 {
            who = ctx.accounts.member_who_trust.bought;
        }else if ctx.accounts.member_who_trust.staked != 0 {
            who = ctx.accounts.member_who_trust.staked;
        }
        
        // Set amount for staked or unstaked status
        if ctx.accounts.member_to_trust.bought != 0 {
            to = ctx.accounts.member_to_trust.bought;
        }else if ctx.accounts.member_to_trust.staked != 0 {
            to = ctx.accounts.member_to_trust.staked;
        }        
        
        //Sharing or shared member must be between half and double of self deposit 
        require!(
            (who >= to/2) &&
            (who <= to*2),
            ErrorCode::AmountBetwenHalfAndDouble
        );
        
        //Sharing or shared member must be between half and double of self deposit 
        require!(
            (to >= who/2) &&
            (to <= who*2),
            ErrorCode::AmountBetwenHalfAndDouble
        );       
         
        // Check if user already unstaked in this round and return tokens if so
        let unstaked =
            ctx.accounts.member_to_trust.unstaked &&
                ctx.accounts.member_to_trust.staked_round ==    
                Some(ctx.accounts.round.key());        
       
        // Transfer trusted tokens to the memeber.
        {
            let seeds = &[
                ctx.accounts.registrar.to_account_info().key.as_ref(),
                ctx.accounts.member_who_trust.to_account_info().key.as_ref(),
                &[ctx.accounts.member_who_trust.nonce],
            ];
            let member_signer = &[&seeds[..]];
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info().clone(),
                token::Transfer {
                    from: ctx.accounts.member_who_trust_fctr_vault.to_account_info(),
                    to: ctx.accounts.member_to_trust_fctr_vault.to_account_info(),
                    authority: ctx.accounts.member_who_trust_signer.to_account_info(),
                },
                member_signer,
            );
            token::transfer(cpi_ctx, amount)?;
        }        
        
        if unstaked {
            let seeds = &[
                ctx.accounts.registrar.to_account_info().key.as_ref(),
                ctx.accounts.member_to_trust.to_account_info().key.as_ref(),
                &[ctx.accounts.member_to_trust.nonce],
            ];
            let member_signer = &[&seeds[..]];              
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info().clone(),
                token::Transfer {
                    from: ctx.accounts.member_to_trust_fctr_vault.to_account_info(),
                    to: ctx.accounts.member_who_trust_fctr_vault.to_account_info(),
                    authority: ctx.accounts.member_to_trust_signer.to_account_info(),
                },
                member_signer,
            );                    
            token::transfer(cpi_ctx, amount)?;         
            return Ok(());
        }
        
        // Calculate increase of base APR for member who trust his tokens
        let x_apr = part_calculation_x10_5(
            &(ctx.accounts.member_who_trust.bought +ctx.accounts.member_who_trust.trusted-ctx.accounts.member_who_trust.shared),
            &amount,
            &ACCURACY
        );

        // Save information of the truster in members acount in MemberToMember struct.
        let mut cur_i =0;
        let mut found = false;
        // Find truster in trusted pool
        for (i, m_t_m) in ctx.accounts.member_to_trust.trusted_pool.iter().enumerate() {
            
            if m_t_m.member_who_trust == ctx.accounts.member_who_trust.key() {
                cur_i = i;
                found = true;
                break;
            }
        }        
        
        if !found {
            // insert new memtomem
            let mem_to_mem = MemberToMember {   
                member_who_trust: *ctx.accounts.member_who_trust.to_account_info().key,  
                fctr: *ctx.accounts.member_who_trust_fctr_vault.to_account_info().key,
                bcdev: *ctx.accounts.member_who_trust_bcdev_vault.to_account_info().key,
                trusted_amount: amount,   
            };
            if ctx.accounts.member_to_trust.trusted_pool.len() < 4 {
                ctx.accounts.member_to_trust.trusted_pool.push(mem_to_mem);
            } else {msg!(" Member already have 4 shares");}
        } else {
            // or encrease shared amount value for member
            ctx.accounts.member_to_trust.trusted_pool[cur_i].trusted_amount += amount;            
        }
        
        //Increase trusted counter amount for member to whom trusted 
        ctx.accounts.member_to_trust.trusted += amount;        
        
        // Increase shared amount counter for member who trust
        ctx.accounts.member_who_trust.shared += amount;

        // Save shared time to member
        ctx.accounts.member_who_trust.shared_time = ctx.accounts.clock.unix_timestamp;

        // Save shared time to truster to member account for calculating 30 rounds lock
        ctx.accounts.truster_to_member.last_time_trusted=
            ctx.accounts.clock.unix_timestamp;
        
        // If member already staked automatic staking of trusted
        if ctx.accounts.member_to_trust.staked > 0 {            
        
            // Check that member is staking to current round
            require!(
                ctx.accounts.registrar.current_round ==
                    ctx.accounts.round.number,
                ErrorCode::StakingNotToCurrentRound
            );
            
            // Check that current round still goes on
            require!(
                ctx.accounts.round.stop_ts >
                    ctx.accounts.clock.unix_timestamp,
                ErrorCode::RoundTimeIsOverStaking
            );

            // Get amount for stake
            let token_amount = amount;            

            // Transfer tokens into the stake vault.
            {
                let seeds = &[
                    ctx.accounts.registrar.to_account_info().key.as_ref(),
                    ctx.accounts.member_to_trust.to_account_info().key.as_ref(),
                    &[ctx.accounts.member_to_trust.nonce],
                ];
                let member_signer = &[&seeds[..]];
                let cpi_ctx = CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info().clone(),
                    token::Transfer {
                        from: ctx.accounts.member_to_trust_fctr_vault.to_account_info(),
                        to: ctx.accounts.registrar_vault.to_account_info(),
                        authority: ctx.accounts.member_to_trust_signer.to_account_info(),
                    },
                    member_signer,
                );                
                token::transfer(cpi_ctx, token_amount)?;
            }
            
            // Calculate time for what current stake would be
            let staked_time = ctx.accounts.round.stop_ts - ctx.accounts.clock.unix_timestamp;
            msg!("staked_time {}",staked_time);

            // Calculate additional apr if not alredy this member trust
            let mut add_apr=0;
            if !found {
                add_apr = 2 * ACCURACY;
            }                    
            msg!("apr {} with add {}",x_apr,add_apr);

            // Calculate reward amount for the calculated time with calculated percents
            let spt_amount = apr_calculation (
                &token_amount,                
                &(x_apr + add_apr), 
                &ctx.accounts.registrar.round_timelock,
                &staked_time,
            );
            msg!("spt_amount {}",spt_amount);      
            msg!("{} percent part for {} FCTR is {} BCDEV",staked_time as f64 /ctx.accounts.registrar.round_timelock as f64, token_amount, spt_amount);
                            
            // Increase trusted stake value
            ctx.accounts.member_to_trust.staked_trusted += token_amount;

            // Null the member legitim amount
            ctx.accounts.member_to_trust.bought = 0;
            ctx.accounts.member_to_trust.trusted = 0;

            // Increase APR reward with calculated amount
            ctx.accounts.member_to_trust.reward += spt_amount; 
            // Mark staking status    
            ctx.accounts.member_to_trust.unstaked = false;       
        }               
        
        // Ctreate trust check struct
        let check = &mut ctx.accounts.trust_check;
        check.member_who_trust = ctx.accounts.member_who_trust.key();
        check.member_to_trust = ctx.accounts.member_to_trust.key();
        check.amount = amount;
        check.round = ctx.accounts.round.key();
        check.time_trusted = ctx.accounts.clock.unix_timestamp;
        check.burn = false;        
        
        Ok(())
    }
    
    // Takes back shared tokens and gives back owns
    pub fn exit_sharing<'info>( ctx: Context<'_,'_,'_,'info, ExitSharing<'info>>) -> Result<()> {
        
        // Find memeber to member struct at shared member trust pool        
        let mut cur_i = 0;
        let mut found = false;
        for (i, m_t_m) in ctx.accounts.member_to_trust.trusted_pool.iter().enumerate() {            
            if m_t_m.member_who_trust == ctx.accounts.member_who_trust.key() {
                cur_i = i;
                found = true;
                break;
            }
        }

        // If not found there is nothing to take back
        if !found {
            require!(false, ErrorCode::MemberDidntShare);
        } 

        // Get shared amount
        let amount = ctx.accounts.member_to_trust.trusted_pool[cur_i].trusted_amount;
        
        // Calculate registrar sign
        let seeds_r = &[
            ctx.accounts.registrar.to_account_info().key.as_ref(),
            &[ctx.accounts.registrar.nonce],
        ];
        let registrar_signer = &[&seeds_r[..]];
        
        //Check that trusted tokens were already staked
        if ctx.accounts.member_to_trust.staked_trusted > 0 {
        
            // Transfer tokens back to member who trust.
            {                    
                let cpi_ctx = CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info().clone(),
                    token::Transfer {
                        from: ctx.accounts.registrar_vault.to_account_info(),
                        to: ctx.accounts.member_who_trust_fctr_vault.to_account_info(),
                        authority: ctx.accounts.registrar_signer.to_account_info(),
                    },
                    registrar_signer,
                );                   
                token::transfer(cpi_ctx, amount)?;
            }
            
            // Decrease counter for trusted stake
            ctx.accounts.member_to_trust.staked_trusted-=amount;
            
            //Calculate the decrease of reward for given tokens
            let staked_time = ctx.accounts.round.stop_ts - ctx.accounts.clock.unix_timestamp;            
            
            // The decrease is for 2% multiplied 100000 number for trusted stake    
            let apr = 2 * ACCURACY;                   
            
            //Calculate APR for the calculated time with calculated percents
            let spt_amount = apr_calculation (
                &amount,
                &apr, 
                &ctx.accounts.registrar.round_timelock,
                &staked_time,
            );            
            msg!("{} percent part for {} FCTR is {} BCDEV",staked_time as f64 /ctx.accounts.registrar.round_timelock as f64, amount, spt_amount);  
        
            // Decrease APR reward with calculated amount
            ctx.accounts.member_to_trust.reward -= spt_amount;       
        
        
        } else {
            // If tokens was not staked, just transfer tokens back.
            {
                // Calculate sign for trusted party
                let seeds = &[
                    ctx.accounts.registrar.to_account_info().key.as_ref(),
                    ctx.accounts.member_to_trust.to_account_info().key.as_ref(),
                    &[ctx.accounts.member_to_trust.nonce],
                ];
                let member_signer = &[&seeds[..]];
                // And transfer tokens 
                let cpi_ctx = CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info().clone(),
                    token::Transfer {
                        from: ctx.accounts.member_to_trust_fctr_vault.to_account_info(),
                        to: ctx.accounts.member_who_trust.to_account_info(),
                        authority: ctx.accounts.member_to_trust_signer.to_account_info(),
                    },
                    member_signer,
                );
                token::transfer(cpi_ctx, amount)?;
            }
            
            // Decrease trusted counter
            ctx.accounts.member_to_trust.trusted-= amount;
        }
        
        
        // Removes member from trusted pool, and shifts remaining to the left
        ctx.accounts.member_to_trust.trusted_pool.remove(cur_i);   
        
        // Decrease shared counter
        ctx.accounts.member_who_trust.shared-=amount; 
  
        // Burn trust check
        ctx.accounts.trust_check.burn=true;       
        
        // Give trusted amounts to trusters         
        // Check that member has trusters for tokens and give them back
        if ctx.accounts.member_who_trust.trusted_pool.len() > 0 {
        
            // Check the provided remaining account 
            let provided_remaining_accounts = &mut ctx.remaining_accounts.iter();

            // Check that number of provide accounts correlates to trusters number
            require!(
                provided_remaining_accounts.len()==
                    ctx.accounts.member_who_trust.trusted_pool.len(),
                ErrorCode::LowRemainingAccountsProvided
            );            
            
            // Iterate over remaining accounts
            let mut i=0;
            while i < ctx.remaining_accounts.len() {

                // Deserealize remaining accounts 
                let vault_fctr = next_account_info(provided_remaining_accounts)?;
                                
                //Check that accounts are spl-tokens
                require!(vault_fctr.owner== &token::ID, ErrorCode::VaultWrongOwner);
                
                // Check that account are equal to saved in Member account
                require!(vault_fctr.key== &ctx.accounts.member_who_trust.trusted_pool[i].fctr, ErrorCode::VaultWrongKey);
                
                // If tokens were already staked
                if ctx.accounts.member_who_trust.staked_trusted > 0 {
                
                    // Transfer fctr back from registrar
                    {
                        let cpi_ctx = CpiContext::new_with_signer(
                            ctx.accounts.token_program.to_account_info().clone(),
                            token::Transfer {
                                from: ctx.accounts.registrar_vault.to_account_info(),
                                to: ctx.remaining_accounts[i].to_account_info(),
                                authority: ctx.accounts.registrar_signer.to_account_info(),
                            },
                            registrar_signer,
                        );                        
                        token::transfer(cpi_ctx, ctx.accounts.member_who_trust.trusted_pool[i].trusted_amount)?;
                    }
                } else {
                
                    // If tokens was not staked transfer fctr back from member
                    {
                        // Calculate sign for member
                        let seeds = &[
                            ctx.accounts.registrar.to_account_info().key.as_ref(),
                            ctx.accounts.member_who_trust.to_account_info().key.as_ref(),
                            &[ctx.accounts.member_who_trust.nonce],
                        ];
                        let member_signer = &[&seeds[..]];
                        // And transfer
                        let cpi_ctx = CpiContext::new_with_signer(
                            ctx.accounts.token_program.to_account_info().clone(),
                            token::Transfer {
                                from: ctx.accounts.member_who_trust_fctr_vault.to_account_info(),
                                to: ctx.remaining_accounts[i].to_account_info(),
                                authority: ctx.accounts.member_who_trust_signer.to_account_info(),
                            },
                            member_signer,
                        );
                        token::transfer(cpi_ctx,  ctx.accounts.member_who_trust.trusted_pool[i].trusted_amount)?;
                    }
                }                
                
                ctx.accounts.member_who_trust.trusted-= ctx.accounts.member_who_trust.trusted_pool[i].trusted_amount;
                
                // Iterate over remaining_accounts
                i+=1;                
            }

            // Zero trusted pull after token return
            ctx.accounts.member_who_trust.trusted_pool=vec![];                 
        }
        
        //Emit exit sharing event
        emit!(ExitSharingEventLog {
            member: *ctx.accounts.member_who_trust.to_account_info().key,
            ts: ctx.accounts.clock.unix_timestamp,   
            //cursor: cursor,
        });

        Ok(())
    }
    
    // Check unstaking by the member to who you trust
    pub fn check_unstaked(ctx: Context<CheckUnstaked>) -> Result<()> {
        
        // Check that round is already ended
        require!(
            ctx.accounts.registrar.current_round >
                ctx.accounts.round.number,
            ErrorCode::EarlyUnstakingCheck
        );

        // Check if member not unstaked
        if !ctx.accounts.member_to_trust.unstaked  {

            // There must be not the current round
            require!(ctx.accounts.member_to_trust.staked_round !=
                    Some(ctx.accounts.round.key()),
                ErrorCode::EarlyUnstakingCheck
            );            
        }

        // Decrease member shared counter
        ctx.accounts.member_who_trust.shared -= ctx.accounts.trust_check.amount;

        // Burn the check
        ctx.accounts.trust_check.burn=true;        
        
        Ok(())
    }
    
    
    // Check exit by the member to who you trust
    pub fn check_exit(ctx: Context<CheckExit>) -> Result<()> {

        // Check if shared counter already zeroed
        require!(
            ctx.accounts.member_to_trust.shared==0,
            ErrorCode::MemberDidntExit
        );

        // Decrease member shared counter
        ctx.accounts.member_who_trust.shared -= ctx.accounts.trust_check.amount;
        
        // Burn the check
        ctx.accounts.trust_check.burn=true;
        
        Ok(())
    }
    
    // Withdrow lamports by owner
    pub fn withdraw_lamports(ctx: Context<WithdrawLamports>) -> Result<()> {
        
        // Check if the time after final round is more then two rounds time
        if 
            !ctx.accounts.registrar.finalized ||
            ctx.accounts.clock.unix_timestamp < ctx.accounts.round.stop_ts +
                ctx.accounts.registrar.round_timelock * 2 {

            // If not,  check that members sold all their tokens
            require!(
                ctx.accounts.pool_mint.supply==0 &&
                ctx.accounts.mint.supply==0,
                ErrorCode::ThereIsSomeSupply,
            );
        } 
        
        // Get registrar lamports amount
        let amount = **ctx.accounts.vault_sol_account.try_borrow_lamports()?;
        
        // Transfer lamports to owner
        **ctx.accounts.vault_sol_account.try_borrow_mut_lamports()? -= amount ;
        **ctx.accounts.authority.try_borrow_mut_lamports()? += amount ;          
        
        Ok(())
    }
    
}

#[derive(Accounts)]
#[instruction(_bump: u8)]
pub struct Initialize<'info> {
    #[account(zero)]
    registrar: Account<'info, Registrar>,    
    pool_mint: Account<'info, Mint>,
    /// CHECK: This is not dangerous because we don't read or write from this account
    #[account(
        init,
        seeds = [b"sol-seed".as_ref()],        
        payer = payer,
        bump,
        space = 8 + 8,
    )]
    vault_sol_account: AccountInfo<'info>,
    /// CHECK: This is not dangerous because we don't read or write from this account
    #[account(mut)]
    payer: Signer<'info>,
    system_program: Program<'info, System>,
    
}

impl<'info> Initialize<'info> {
    fn accounts(ctx: &Context<Initialize<'info>>, nonce: u8) -> Result<()> {
        let registrar_signer = Pubkey::create_program_address(
            &[
                ctx.accounts.registrar.to_account_info().key.as_ref(),
                &[nonce],
            ],
            ctx.program_id,
        )
        .map_err(|_| error!(ErrorCode::InvalidNonce))?;
        if ctx.accounts.pool_mint.mint_authority != COption::Some(registrar_signer) {
            return err!(ErrorCode::InvalidPoolMintAuthority);
        }
        assert!(ctx.accounts.pool_mint.supply == 0);
        Ok(())
    }
}


#[derive(Accounts)]
pub struct CreateMember<'info> {    
    registrar: Box<Account<'info, Registrar>>,          
    #[account(
        init,
        payer = beneficiary,
        space = 32 + 32 + 8 + 8 + 8 + 8 + 8 + 8 + (1+32) + 1 + 8  + 1 + 1 + 4 + (32 + 32 + 32 + 8 )*4,
        
    )]
    member: Box<Account<'info, Member>>,
    #[account(mut)]
    beneficiary: Signer<'info>,   
    /// CHECK: It checked in CreateMember::accounts 
    member_signer: AccountInfo<'info>,    
    token_program: Program<'info, Token>,
    rent: Sysvar<'info, Rent>,    
    system_program: Program<'info, System>,
}

impl<'info> CreateMember<'info> {
    fn accounts(ctx: &Context<CreateMember>, nonce: u8) -> Result<()> {
        let seeds = &[
            ctx.accounts.registrar.to_account_info().key.as_ref(),
            ctx.accounts.member.to_account_info().key.as_ref(),
            &[nonce],
        ];
        let member_signer = Pubkey::create_program_address(seeds, ctx.program_id)
            .map_err(|_| error!(ErrorCode::InvalidNonce))?;
        if &member_signer != ctx.accounts.member_signer.to_account_info().key {
            return err!(ErrorCode::InvalidMemberSigner);
        }
        Ok(())
    }
}

#[derive(Accounts)]
pub struct BuyFctr<'info> {
    #[account(has_one = mint)]
    registrar: Account<'info, Registrar>,
    /// CHECK: checked with registrar
    #[account(
        seeds = [registrar.to_account_info().key.as_ref()],
        bump = registrar.nonce,
    )]
    registrar_signer: AccountInfo<'info>,
    #[account(mut)]
    mint: Account<'info, Mint>,
    #[account(mut)]
    buyer: Signer<'info>,
    #[account(
        mut,
        has_one = registrar,
        constraint = member.beneficiary == *buyer.key
    )]
    member: Box<Account<'info, Member>>,
    /// CHECK: checked with seed
    #[account(
        mut,
        seeds = [b"sol-seed",],
        bump
    )]
    vault_sol_account: AccountInfo<'info>,  
    #[account(mut)]
    vault: Account<'info, TokenAccount>,
    token_program: Program<'info, Token>,
    system_program: Program<'info, System>,
}


#[derive(Accounts)]
pub struct TransferFctr<'info> {
    //#[account(has_one = pool_mint)]
    registrar: Account<'info, Registrar>,
    /// CHECK: checked with seeds
    #[account(
        seeds = [
            registrar.to_account_info().key.as_ref(),
            member.to_account_info().key.as_ref(),
        ],
        bump = member.nonce,
    )]
    member_signer: AccountInfo<'info>,  
    beneficiary: Signer<'info>,
    #[account(
        mut,
        has_one = registrar,
        has_one = beneficiary,
    )]
    member: Box<Account<'info, Member>>,
    #[account(mut)]
    vault_fctr: Account<'info, TokenAccount>,
    #[account(mut)]
    token_holder:Account<'info, TokenAccount>,
    token_program: Program<'info, Token>,    
}

#[derive(Accounts)]
pub struct SellFctr<'info> {
    #[account(has_one = mint)]
    registrar: Account<'info, Registrar>,
    /// CHECK: checked with seed
    #[account(
        seeds = [
            registrar.to_account_info().key.as_ref(),
            member.to_account_info().key.as_ref(),
        ],
        bump = member.nonce,
    )]
    member_signer: AccountInfo<'info>,
    #[account(mut)]
    mint: Account<'info, Mint>,
    #[account(mut)]
    beneficiary: Signer<'info>,
    #[account(
        mut,
        has_one = registrar,
        has_one = beneficiary,
    )]
    member: Box<Account<'info, Member>>,
    /// CHECK: check with seed
    #[account(
        mut,
        seeds = [b"sol-seed",],
        bump
    )]
    vault_sol_account: AccountInfo<'info>,  
    #[account(mut)]
    vault: Account<'info, TokenAccount>,
    token_program: Program<'info, Token>,
    system_program: Program<'info, System>,
}


#[derive(Accounts)]
pub struct SellBcdev<'info> {
    #[account(has_one = pool_mint)]
    registrar: Account<'info, Registrar>,
    /// CHECK: checked with seed
    #[account(
        seeds = [
            registrar.to_account_info().key.as_ref(),
            member.to_account_info().key.as_ref(),
        ],
        bump = member.nonce,
    )]
    member_signer: AccountInfo<'info>,
    #[account(mut)]
    pool_mint: Account<'info, Mint>,
    #[account(mut)]
    beneficiary: Signer<'info>,
    #[account(
        mut,
        has_one = registrar,
        has_one = beneficiary,
    )]
    member: Box<Account<'info, Member>>,
    /// CHECK: check with seed
    #[account(
        mut,
        seeds = [b"sol-seed",],
        bump
    )]
    vault_sol_account: AccountInfo<'info>,  
    #[account(mut)]
    vault_bcdev: Account<'info, TokenAccount>,
    token_program: Program<'info, Token>,
    system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct StartRound<'info> {
    #[account(mut, has_one = authority)]
    registrar: Account<'info, Registrar>,
    authority: Signer<'info>,
    #[account(zero)]
    round: Box<Account<'info, Round>>,    
    clock: Sysvar<'info, Clock>,
    system_program: Program<'info, System>,    
}

#[derive(Accounts)]
pub struct Stake<'info> {     
    /// Registrar
    #[account(
        has_one = pool_mint,
    )]
    registrar: Box<Account<'info, Registrar>>,    
    #[account(mut)]
    registrar_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pool_mint: Account<'info, Mint>,        
    beneficiary: Signer<'info>,
    #[account(
        mut,
        has_one = registrar,
        has_one = beneficiary,
    )]
    member: Box<Account<'info, Member>>,
    /// CHECK: checked with seed
    #[account(
        seeds = [
            registrar.to_account_info().key.as_ref(),
            member.to_account_info().key.as_ref(),
        ],
        bump = member.nonce,
    )]
    member_signer: AccountInfo<'info>,
    #[account(mut)]
    member_fctr_vault: Account<'info, TokenAccount>,    
    #[account(       
        has_one = registrar, 
	constraint = registrar.current_round_account == Some(round.key()),         
    )]
    round: Box<Account<'info, Round>>,    
    clock: Sysvar<'info, Clock>,
    token_program: Program<'info, Token>,
    system_program: Program<'info, System>,    
}


#[derive(Accounts)]
pub struct Unstake<'info> {
    #[account(
        has_one = pool_mint,        
    )]
    registrar: Box<Account<'info, Registrar>>,
    /// CHECK: checked with seed
    #[account(
        seeds = [registrar.to_account_info().key.as_ref()],
        bump = registrar.nonce,
    )]
    registrar_signer: AccountInfo<'info>,
    #[account(mut)]
    registrar_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pool_mint: Account<'info, Mint>,
    ///Staker
    beneficiary: Signer<'info>,
    #[account(
        mut,
        has_one = registrar,
        has_one = beneficiary,
    )]
    member: Box<Account<'info, Member>>,    
    #[account(mut)]
    member_fctr_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    member_bcdev_vault: Account<'info, TokenAccount>,
    #[account(       
        has_one = registrar,     
    )]
    round: Box<Account<'info, Round>>,    
    clock: Sysvar<'info, Clock>,
    token_program: Program<'info, Token>,
    system_program: Program<'info, System>,    
}

#[derive(Accounts)]
pub struct TrustToMember<'info> { 
    registrar: Box<Account<'info, Registrar>>,

    ///Member who trust
    #[account(mut)]
    beneficiary: Signer<'info>,
    #[account(
        mut,
        has_one = registrar,
        has_one = beneficiary,
    )]
    member_who_trust: Box<Account<'info, Member>>,
    /// CHECK: checked with seed
    #[account(
        seeds = [
            registrar.to_account_info().key.as_ref(),
            member_who_trust.to_account_info().key.as_ref(),
        ],
        bump = member_who_trust.nonce,
    )]
    member_who_trust_signer: AccountInfo<'info>,
    #[account(mut)]
    member_who_trust_fctr_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    member_who_trust_bcdev_vault: Account<'info, TokenAccount>,
    
    /// Member to whom trust
    //account_to_trust: AccountInfo<'info>,
    #[account(
        mut,
        has_one = registrar,        
    )]
    member_to_trust: Box<Account<'info, Member>>,    
    #[account(mut)]
    member_to_trust_fctr_vault: Account<'info, TokenAccount>,
    /// CHECK: checked with seed
    #[account(
        seeds = [
            registrar.to_account_info().key.as_ref(),
            member_to_trust.to_account_info().key.as_ref(),
        ],
        bump = member_to_trust.nonce,
    )]
    member_to_trust_signer: AccountInfo<'info>, 
  
    ///Trust check
    #[account(zero)]
    trust_check: Box<Account<'info, TrustCheck>>,  
    
    #[account(mut)]
    registrar_vault: Account<'info, TokenAccount>,
    #[account(       
        has_one = registrar, 
	constraint = registrar.current_round_account == Some(round.key()),         
    )]
    round: Box<Account<'info, Round>>,        
    #[account(
        init_if_needed,
        payer = beneficiary,
        space = 8 + 8,
        seeds = [
             beneficiary.key().as_ref(),
             member_to_trust.key().as_ref(),
         ],
         bump
    )]
    pub truster_to_member : Box<Account<'info, TrusterToMember>>,      
    clock: Sysvar<'info, Clock>,
    token_program: Program<'info, Token>,
    system_program: Program<'info, System>,    
}

#[derive(Accounts)]
pub struct ExitSharing<'info> {         
    registrar: Box<Account<'info, Registrar>>,    
    /// CHECK: checked with seed
    #[account(
        seeds = [registrar.to_account_info().key.as_ref()],
        bump = registrar.nonce,
    )]
    registrar_signer: AccountInfo<'info>,
    #[account(mut)]
    registrar_vault: Account<'info, TokenAccount>,   
 
    ///Member who trusted
    beneficiary: Signer<'info>,
    #[account(
        mut,
        has_one = registrar,
        has_one = beneficiary,
    )]
    member_who_trust: Box<Account<'info, Member>>,
    /// CHECK: checked with seed
    #[account(
        seeds = [
            registrar.to_account_info().key.as_ref(),
            member_who_trust.to_account_info().key.as_ref(),
        ],
        bump = member_who_trust.nonce,
    )]
    member_who_trust_signer: AccountInfo<'info>,
    #[account(mut)]
    member_who_trust_fctr_vault: Account<'info, TokenAccount>,
    
    /// Member to whom trust
    //account_to_trust: AccountInfo<'info>,
    #[account(
        mut,
        has_one = registrar,        
    )]
    member_to_trust: Box<Account<'info, Member>>,    
    #[account(mut)]
    member_to_trust_fctr_vault: Account<'info, TokenAccount>,
    /// CHECK: checked with seed
    #[account(
        seeds = [
            registrar.to_account_info().key.as_ref(),
            member_to_trust.to_account_info().key.as_ref(),
        ],
        bump = member_to_trust.nonce,
    )]
    member_to_trust_signer: AccountInfo<'info>,        
    
    ///Round
    #[account(       
        has_one = registrar,                 
    )]
    round: Box<Account<'info, Round>>,  
    #[account(  
        mut,
        has_one = round,   
        has_one = member_to_trust,
        has_one = member_who_trust,
        constraint = trust_check.burn == false,
    )]
    trust_check: Box<Account<'info, TrustCheck>>,  
      
    clock: Sysvar<'info, Clock>,
    token_program: Program<'info, Token>,    
}

#[derive(Accounts)]
pub struct WithdrawLamports<'info> {
    #[account(
    has_one = mint,
    has_one = pool_mint,
    has_one = authority,
    )]
    registrar: Account<'info, Registrar>,    
    #[account(       
        has_one = registrar, 
        constraint = registrar.current_round_account == Some(round.key()), 
        constraint = round.final_round ==true,        
    )]
    round: Box<Account<'info, Round>>,  
    #[account()]
    mint: Account<'info, Mint>,
    #[account()]
    pool_mint: Account<'info, Mint>,    
    ///Owner
    #[account(mut)]
    authority: Signer<'info>,    
    /// CHECK: checked with seed
    #[account(
        mut,
        seeds = [b"sol-seed",],
        bump
    )]
    vault_sol_account: AccountInfo<'info>,  
    
    clock: Sysvar<'info, Clock>,
    system_program: Program<'info, System>,
}


#[derive(Accounts)]
pub struct CheckUnstaked<'info> {    
    registrar: Account<'info, Registrar>,    
    #[account(       
        has_one = registrar,                 
    )]
    round: Box<Account<'info, Round>>,  
    #[account(
        mut,
        has_one = registrar,        
    )]
    member_to_trust: Box<Account<'info, Member>>,       
    #[account(
        mut,
        has_one = registrar,
        has_one = beneficiary,
    )]
    member_who_trust: Box<Account<'info, Member>>,   
    beneficiary: Signer<'info>,  
    #[account(  
        mut,
        has_one = round,   
        has_one = member_to_trust,
        has_one = member_who_trust,
        constraint = trust_check.burn == false,
    )]
    trust_check: Box<Account<'info, TrustCheck>>,      
}


#[derive(Accounts)]
pub struct CheckExit<'info> {    
    registrar: Account<'info, Registrar>,    
    #[account(       
        has_one = registrar,                 
    )]
    round: Box<Account<'info, Round>>,  
    #[account(
        mut,
        has_one = registrar,        
    )]
    member_to_trust: Box<Account<'info, Member>>,       
    #[account(
        mut,
        has_one = registrar,
        has_one = beneficiary,
    )]
    member_who_trust: Box<Account<'info, Member>>,   
    beneficiary: Signer<'info>,  
    #[account(  
        mut,
        has_one = round,   
        has_one = member_to_trust,
        has_one = member_who_trust,
        constraint = trust_check.burn == false,
    )]
    trust_check: Box<Account<'info, TrustCheck>>,      
}


#[account]
pub struct Registrar {
    /// Priviledged account.
    pub authority: Pubkey,
    /// Nonce to derive the program-derived address owning the vaults.
    pub nonce: u8,
    /// Status finalized flag
    pub finalized: bool,        
    /// Mint of the FCTR tokens that can be staked.
    pub mint: Pubkey,
    /// Staking pool BCDEV token mint.
    pub pool_mint: Pubkey,
    /// Number of seconds that must pass for a round to complete.
    pub round_timelock: i64,
    /// Last round number
    pub current_round: u32,
    // Last round account
    pub current_round_account: Option<Pubkey>,    
}

#[account]
pub struct Member {
    /// Registrar the member belongs to.
    pub registrar: Pubkey,
    /// The effective owner of the Member account.
    pub beneficiary: Pubkey,
    /// Number of bought FCTR
    pub bought: u64,
    /// Number of trusted FCTR
    pub trusted: u64,
    /// Sharing program status flag
    pub shared: u64,    
    /// Shared time
    pub shared_time: i64,    
    /// Staked FCTR amount
    pub staked: u64,
    ///Staked trusted FCTR
    pub staked_trusted: u64,
    /// Last round staked
    pub staked_round: Option<Pubkey>,
    /// Unstaked flag
    pub unstaked: bool,
    /// Reward for the round in BCDEV
    pub reward: u64,    
    /// Dont participate in sharing flag
    pub dont_participate_sharing: bool,
    /// Vec of trusters
    pub trusted_pool: Vec<MemberToMember>,
    /// Signer nonce.
    pub nonce: u8,
}

#[account]
pub struct Round {
    /// Registrar the round belongs to.
    pub registrar: Pubkey,
    /// Round start time
    pub start_ts: i64,
    ///Round period
    pub stop_ts: i64,
    ///Round number
    pub number: u32,
    /// Finalyty flag
    pub final_round: bool,        
}


#[account]
pub struct TrustCheck { 
    /// Member who trust     
    pub member_who_trust :Pubkey,
    /// Member to trust
    pub member_to_trust: Pubkey,
    /// Trusted amount
    pub amount: u64,
    /// Trusted round
    pub round: Pubkey,
    /// Time when trusted
    pub time_trusted: i64,    
    /// Burn status
    pub burn: bool,
}

#[account]
pub struct TrusterToMember {      
    pub last_time_trusted: i64,    
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct MemberToMember {    
    /// Member who trust
    pub member_who_trust: Pubkey,   
    /// FCTR account
    pub fctr: Pubkey,
    /// BCDEV account
    pub bcdev: Pubkey,
    /// trusted amount
    pub trusted_amount: u64,        
}

#[error_code]
pub enum ErrorCode {
    #[msg("The nonce given doesn't derive a valid program address.")]
    InvalidNonce,
    #[msg("Invalid pool mint authority")]
    InvalidPoolMintAuthority,
    #[msg("Member signer doesn't match the derived address.")]
    InvalidMemberSigner,
    #[msg("The amount provided is smaler then requested")]
    AmountTooSmall,
    #[msg("There is not enouph SOL balance for transaction")]
    InsufficientFundsForTransaction,
    #[msg("Staking not to current round")]
    StakingNotToCurrentRound,
    #[msg("Round time is over for staking")]
    RoundTimeIsOverStaking,
     #[msg("Staking round is not over")]
    EarlyUnstaking,
    #[msg("Round time is not over for unstaking")]
    RoundTimeIsOverUnstaking,
    #[msg("Staking is finalized, you can not create more rounds")]
    StakingFinalized,
    #[msg("The requested for trade amount of token is greater then disposable")]
    InsuficientUserFunds,
    #[msg("There can not be more then 4 trusters for the member")]    
    MemberTrustersAmountExceeded,
    #[msg("You can not buy or sell FCRT while participating in sharing program")] 
    CantBuyOfSharing,
    #[msg("You can share only bought tokens")] 
    ShareOnlyBought,
    #[msg("You can transfer only bought tokens")] 
    TransferOnlyBought,
    #[msg("Sharing amount is more then half of provided")] 
    AmountMoreThenHalf,
    #[msg("Sharing makes the rest of tokens les then quater of bought")] 
    AmountLesThenQuater,
    #[msg("Member you want to trust, does not participate sharing programm")] 
    MemberDontParticipateSharing,
    #[msg("Provided too low accounts for trusted parties ")] 
    LowRemainingAccountsProvided,
    #[msg("Wrong vault owner ")] 
    VaultWrongOwner,
    #[msg("Wrong vault key ")] 
    VaultWrongKey,
    #[msg("Requested tokens was not shared to the member ")] 
    MemberDidntShare,
    #[msg("Member can not take trusted tokens more the once in 30 round times ")] 
    OftenSharingParticipation,
    #[msg("Owner can not withdraw lamport becouse not all tokens are sold ")] 
    ThereIsSomeSupply,
    #[msg("Memeber did not unstaked yet ")] 
    EarlyUnstakingCheck,
    #[msg("Memeber did not exited sharing program ")] 
    MemberDidntExit,
    #[msg("Sharing or shared member must be between half and double of self deposit ")] 
    AmountBetwenHalfAndDouble,
    #[msg("Nor enouph tokens for stake ")] 
    NotEnouphForStake,
    #[msg("User does not have a stake ")] 
    DidntStakedAnything    
}


#[event]
pub struct RoundEventLog {
    round: Pubkey,
    ts: i64,    
}

#[event]
pub struct RewardEventLog {
    member: Pubkey,
    ts: i64,       
}

#[event]
pub struct ExitSharingEventLog {
    member: Pubkey,
    ts: i64,       
}

fn curency_to_sol_in_lamports (
    amount_of_carency: &u64,
    carency: &u64, 
    course: &u64
)-> u64 {      
    let mut lamports_amount = amount_of_carency/(course*carency/LAMPORTS_PER_SOL);     
    let reminder = amount_of_carency%(course*carency/LAMPORTS_PER_SOL);                 
         if reminder!=0{
             if ((lamports_amount * 10 )/reminder) > 4 {
                 lamports_amount+=1;
             } 
         }
    lamports_amount       
}

fn part_calculation_x10_5 (    
    part: &u64,
    all: &u64,
    acc: &u64,
)-> u64 {
    let mut part_x10_5 = part * acc / all;
    let reminder = part * acc % all;
    if reminder!=0 {
        if (part_x10_5*10/reminder)>4 {
            part_x10_5+=1;
        }
    }
    msg!("part_x10_5 {}", part_x10_5 );
    part_x10_5
}

fn apr_calculation (
    amount_of_stake: &u64,
    percent_x10_5: &u64, 
    &round_duration: &i64,
    &staked_time: &i64,
)-> u64 {      
    let part = part_calculation_x10_5(
        &(staked_time as u64) ,
        &(round_duration as u64),
        &ACCURACY 
    );
    
    let mut amount = (part * amount_of_stake)/
        (ACCURACY); 
    let reminder_u64 = (part * amount_of_stake)%
        (ACCURACY); 
    if reminder_u64!=0 {
        if (amount*10/reminder_u64)>4 {
            amount+=1;
        }
    }
    
    let mut fctr_amount = (amount * percent_x10_5) / (100*ACCURACY); 
    let reminder_amount = (amount * percent_x10_5) % (100*ACCURACY); 
    if reminder_u64!=0 {
        if (fctr_amount*10/reminder_amount)>4 {
            fctr_amount+=1;
        }
    }    
    
    fctr_amount*(BCDEV/FCTR)
}
