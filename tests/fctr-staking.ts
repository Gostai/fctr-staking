import * as anchor from "@project-serum/anchor";
import { Program } from "@project-serum/anchor";
import { FctrStaking } from "../target/types/fctr_staking";

import { TOKEN_PROGRAM_ID, Token } from "@solana/spl-token";

const serumCmn = require("@project-serum/common");
const { assert, expect } = require("chai");

describe("fctr-staking", () => {
  // Configure the client to use the local cluster.
  //anchor.setProvider(anchor.AnchorProvider.env());
    
  // Read the provider from the configured environmnet.
  const provider = anchor.AnchorProvider.env();
  
  // hack so we don't have to update serum-common library
  // to the new AnchorProvider class and Provider interface
  provider.send = provider.sendAndConfirm;
  
  // Configure the client to use the provider.
  anchor.setProvider(provider);

  const program = anchor.workspace.FctrStaking as Program<FctrStaking>;
  
  const registrar = anchor.web3.Keypair.generate();
  
  const roundTimelock = new anchor.BN(10);

  let registrarAccount = null;
  
  let registrarSigner = null;
  let nonce = null;
  let mint = null;
  let poolMint = null;
  let vault_sol_account_pda = null;
  let vault_sol_account_bump = null;
  let registrarVault = null;
  
  const SOL = anchor.web3.LAMPORTS_PER_SOL;
  const FCTR =  1000000000000; 
  const BCDEV = 1000000000000000000;   
  const solAmount =1*SOL;
  
  it("Creates registry genesis", async () => {
      
    // Find registrar address
    const [_registrarSigner, _nonce] =
      await anchor.web3.PublicKey.findProgramAddress(
        [registrar.publicKey.toBuffer()],
        program.programId
      );
    registrarSigner = _registrarSigner;
    nonce = _nonce;
    
    //Find PDA for vaultAccount for SOL
    const [_vault_sol_account_pda, _vault_sol_account_bump] = await anchor.web3.PublicKey.findProgramAddress(
      [Buffer.from(anchor.utils.bytes.utf8.encode("sol-seed"))],
      program.programId
    );
    vault_sol_account_pda = _vault_sol_account_pda;
    vault_sol_account_bump = _vault_sol_account_bump;
    
    //FCTR mint
    mint = await serumCmn.createMint(provider, registrarSigner, 12);
    //BCDEV mint
    poolMint = await serumCmn.createMint(provider, registrarSigner, 18);
    
    // Create FCTR token account for registrar
    registrarVault = await serumCmn.createTokenAccount(provider, mint, registrarSigner);
    
  });
  
  it("Initializes the registrar", async () => {
    
    await program.rpc.initialize(
      vault_sol_account_bump,
      mint,
      provider.wallet.publicKey,
      nonce,
      roundTimelock,     
      {
        accounts: {
          registrar: registrar.publicKey,  
          poolMint,
          vaultSolAccount: vault_sol_account_pda,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          payer: provider.wallet.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        },
        signers: [registrar],
        instructions: [
          await program.account.registrar.createInstruction(registrar),                            
        ],
      }
    );
    
    registrarAccount = await program.account.registrar.fetch(
      registrar.publicKey
    );
    
    // Check initialization
    assert.isTrue(registrarAccount.authority.equals(provider.wallet.publicKey));
    assert.strictEqual(registrarAccount.nonce, nonce);
    assert.isTrue(registrarAccount.mint.equals(mint));
    assert.isTrue(registrarAccount.poolMint.equals(poolMint));         
    assert.isTrue(registrarAccount.roundTimelock.eq(roundTimelock));
  });
  
  // Creating Anna member
  const Anna = anchor.web3.Keypair.generate();      
  const memberAnna = anchor.web3.Keypair.generate();    
  let memberAnnaSigner = null;
  let memberAnnaVault = null;
  
  
  it("Creates a member Anna", async () => {
    // Account tot check
    let memberAccount = null;  
      
    // Airdropping tokens to a Anna.
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(Anna.publicKey, solAmount),
      "processed"
    );
    
    
    // Calculate Anna signer
    const [_memberSigner, nonce] =
      await anchor.web3.PublicKey.findProgramAddress(
        [registrar.publicKey.toBuffer(), memberAnna.publicKey.toBuffer()],
        program.programId
      );
    memberAnnaSigner = _memberSigner;
    
    // Create FCRT account for Anna
    memberAnnaVault = await serumCmn.createTokenAccount(provider, mint, memberAnnaSigner);
   
    
    const tx = program.transaction.createMember(nonce, false, {
      accounts: {
        registrar: registrar.publicKey,
        member: memberAnna.publicKey,
        beneficiary: Anna.publicKey,
        memberSigner: memberAnnaSigner,        
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        systemProgram: anchor.web3.SystemProgram.programId,  
      },      
    });

    const signers = [memberAnna, Anna];
    const allTxs = [{ tx, signers }];

    let txSigs = await provider.sendAll(allTxs);
    
    // Check member creation 
    memberAccount = await program.account.member.fetch(memberAnna.publicKey);

    assert.isTrue(memberAccount.registrar.equals(registrar.publicKey));
    assert.isTrue(memberAccount.beneficiary.equals(Anna.publicKey));
    
    assert.ok(memberAccount.bought.toNumber()==0);           
    assert.ok(memberAccount.trusted.toNumber()==0);      
    assert.ok(memberAccount.shared.toNumber()==0);  
  
  });
  
  
  it("Anna buy FCTR ", async () => {
      
    let buyingAmount = new anchor.BN(15*FCTR);
    
    let _vault_sol_before = await provider.connection.getBalance(vault_sol_account_pda);
    
    await program.rpc.buyFctr(      
          buyingAmount,      
      {
        accounts: {          
          registrar:registrar.publicKey,
          registrarSigner,
          mint,
          buyer: Anna.publicKey,
          member: memberAnna.publicKey,
          vaultSolAccount: vault_sol_account_pda,      
          vault: memberAnnaVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,  
        },
        signers: [Anna],
      }
    );    
    
   let _vault_sol_after = await provider.connection.getBalance(vault_sol_account_pda);   
   assert.ok(_vault_sol_before !=_vault_sol_after);   
   
   const memberVault = await serumCmn.getTokenAccount(
      provider,
      memberAnnaVault
    );   
   assert.isTrue(memberVault.amount.eq(buyingAmount));
  });
  
  
  
  it("Sell all FCTR", async () => {
      
    // Airdropping tokens to a registrar vault .
    await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(vault_sol_account_pda, 1*SOL),
        "processed"
    );
    
    let _vault_sol_before = await provider.connection.getBalance(vault_sol_account_pda);
    
    await program.rpc.sellAllFctr(    
      {
        accounts: {     
          registrar:registrar.publicKey,
          memberSigner: memberAnnaSigner,
          mint,
          beneficiary: Anna.publicKey,
          member: memberAnna.publicKey,
          vaultSolAccount: vault_sol_account_pda,      
          vault: memberAnnaVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,  
        },
        signers: [Anna],
      }
    );    
    
   let _vault_sol_after = await provider.connection.getBalance(vault_sol_account_pda);   
   assert.ok(_vault_sol_before !=_vault_sol_after);   
   
   const memberVault = await serumCmn.getTokenAccount(
      provider,
      memberAnnaVault
    );
   
   assert.isTrue(memberVault.amount.eq(new anchor.BN(0)));
  });
  
  const round1 = anchor.web3.Keypair.generate();    
  
  it("Create round", async () => {
    let final_round = false;
      
    await program.rpc.startRound(    
        final_round,
      {
        accounts: {     
           registrar: registrar.publicKey,
           authority: provider.wallet.publicKey,
           round: round1.publicKey,           
           clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
           systemProgram: anchor.web3.SystemProgram.programId,  
          
        },
        signers: [round1],
        instructions: [
          await program.account.round.createInstruction(round1),                        
        ],
      }
    );    
    
    let roundAccount = await program.account.round.fetch(
      round1.publicKey
    );
    
    assert.isTrue(roundAccount.registrar.equals(registrar.publicKey));
    assert.strictEqual(roundAccount.number, 1);
    assert.ok(roundAccount.finalRound==false);   
  });
  
  //Create BCDEV account for Anna  
  let memberAnnaBcdevVault = null;
  
   it("Stake to round", async () => {  
    //Buy some FCTR for Anna   
    let buyingAmount = new anchor.BN(10*FCTR);
    
    await program.rpc.buyFctr(      
          buyingAmount,      
      {
        accounts: {          
          registrar:registrar.publicKey,
          registrarSigner,
          mint,
          buyer: Anna.publicKey,
          member: memberAnna.publicKey,
          vaultSolAccount: vault_sol_account_pda,      
          vault: memberAnnaVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,  
        },
        signers: [Anna],
      }
    );     
    
    await program.rpc.stake(            
      {
        accounts: {     
           registrar: registrar.publicKey,           
           registrarVault,
           poolMint,
           beneficiary: Anna.publicKey,
           member: memberAnna.publicKey,
           memberSigner: memberAnnaSigner,
           memberFctrVault: memberAnnaVault,           
           round: round1.publicKey,           
           clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
           tokenProgram: TOKEN_PROGRAM_ID,
           systemProgram: anchor.web3.SystemProgram.programId,            
        },
        signers: [Anna],
      }
    );    
    
    const memberVault = await serumCmn.getTokenAccount(
      provider,
      memberAnnaVault
    );
   
   assert.isTrue(memberVault.amount.eq(new anchor.BN(0)));
   
   let memberAccount = await program.account.member.fetch(
      memberAnna.publicKey
    );
   
   assert.isTrue(memberAccount.bought.eq(new anchor.BN(0)));
   assert.isTrue(memberAccount.trusted.eq(new anchor.BN(0)));
   assert.isTrue(memberAccount.staked.eq(buyingAmount));
   assert.isTrue(memberAccount.stakedTrusted.eq(new anchor.BN(0)));
   assert.isTrue(memberAccount.shared.eq(new anchor.BN(0)));
  });
     
  it("Buy 5 more FCTR for Anna to increase stake", async () => {
      
    let buyingAmount = new anchor.BN(10*FCTR);    
    
    await program.rpc.buyFctr(      
          buyingAmount,      
      {
        accounts: {          
          registrar:registrar.publicKey,
          registrarSigner,
          mint,
          buyer: Anna.publicKey,
          member: memberAnna.publicKey,
          vaultSolAccount: vault_sol_account_pda,      
          vault: memberAnnaVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,  
        },
        signers: [Anna],
      }
    );    
    
 let memberAccount = await program.account.member.fetch(
      memberAnna.publicKey
    );
   
   assert.isTrue(memberAccount.bought.eq(new anchor.BN(10*FCTR)));   
   assert.isTrue(memberAccount.trusted.eq(new anchor.BN(0)));
   assert.isTrue(memberAccount.staked.eq(new anchor.BN(10*FCTR)));
   assert.isTrue(memberAccount.stakedTrusted.eq(new anchor.BN(0)));
   assert.isTrue(memberAccount.shared.eq(new anchor.BN(0)));
  });
  
  
  it("Anna Stake's to round 2 her additionaly bought 10 FCTR", async () => {  

    await program.rpc.stake(            
      {
        accounts: {     
           registrar: registrar.publicKey,
           registrarVault,
           poolMint,
           beneficiary: Anna.publicKey,
           member: memberAnna.publicKey,
           memberSigner: memberAnnaSigner,
           memberFctrVault: memberAnnaVault,          
           round: round1.publicKey,           
           clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
           tokenProgram: TOKEN_PROGRAM_ID,
           systemProgram: anchor.web3.SystemProgram.programId,  
          
        },
        signers: [Anna],
      }
    );    
    
   let memberAccount = await program.account.member.fetch(
      memberAnna.publicKey
    );
   
   assert.isTrue(memberAccount.bought.eq(new anchor.BN(0)));
   assert.isTrue(memberAccount.trusted.eq(new anchor.BN(0)));
   // Anna has 20 FCTR 
   assert.isTrue(memberAccount.staked.eq(new anchor.BN(20*FCTR)));
   assert.isTrue(memberAccount.stakedTrusted.eq(new anchor.BN(0)));
   assert.isTrue(memberAccount.shared.eq(new anchor.BN(0)));
    
  }); 
   
   
  it("Waits for the lockup period to pass", async () => {
    await serumCmn.sleep(10 * 1000);
  }); 
  
  const round2 = anchor.web3.Keypair.generate();    
  
  it("Create round 2", async () => {
      let final_round = false;
      
    await program.rpc.startRound(    
        final_round,
      {
        accounts: {     
           registrar: registrar.publicKey,
           authority: provider.wallet.publicKey,
           round: round2.publicKey,           
           clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
           systemProgram: anchor.web3.SystemProgram.programId,            
        },
        signers: [round2],
        instructions: [
          await program.account.round.createInstruction(round2),                        
        ],
      }
    );    
    
    let roundAccount = await program.account.round.fetch(
      round2.publicKey
    );
    
    assert.isTrue(roundAccount.registrar.equals(registrar.publicKey));
    assert.strictEqual(roundAccount.number, 2);
    assert.ok(roundAccount.finalRound==false);   
  });
  
   
  it("Unstake from round 1", async () => {  
       
    // Creates BCDEV vault
    memberAnnaBcdevVault = await serumCmn.createTokenAccount(provider, poolMint, memberAnnaSigner);  
    
    await program.rpc.unstake(            
      {
        accounts: {     
           registrar: registrar.publicKey,
           registrarSigner,
           registrarVault,
           poolMint,           
           beneficiary: Anna.publicKey,
           member: memberAnna.publicKey,           
           memberFctrVault: memberAnnaVault,
           memberBcdevVault: memberAnnaBcdevVault,
           round: round1.publicKey,           
           clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
           tokenProgram: TOKEN_PROGRAM_ID,
           systemProgram: anchor.web3.SystemProgram.programId, 
        },
        signers: [Anna],
      }
    );    
    
    const memberVault = await serumCmn.getTokenAccount(
      provider,
      memberAnnaVault
    );
   
   assert.isTrue(memberVault.amount.eq(new anchor.BN(20*FCTR)));
   
   let memberAccount = await program.account.member.fetch(
      memberAnna.publicKey
    );
   
   assert.isTrue(memberAccount.bought.eq(new anchor.BN(20*FCTR)));
   assert.isTrue(memberAccount.trusted.eq(new anchor.BN(0)));     
   assert.isTrue(memberAccount.staked.eq(new anchor.BN(0)));
   assert.isTrue(memberAccount.stakedTrusted.eq(new anchor.BN(0)));
   assert.isTrue(memberAccount.shared.eq(new anchor.BN(0)));
   
    let memberBcdevVault_after = await serumCmn.getTokenAccount(
       provider,
       memberAnnaBcdevVault
     );
    
    assert.isTrue(memberBcdevVault_after.amount.gt(new anchor.BN(0)));
  });
  
  
  it("Sell BCDEV", async () => {
      
    // Airdropping tokens to a donee.
    await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(vault_sol_account_pda, 1*SOL),
        "processed"
    );
    
    let _vault_sol_before = await provider.connection.getBalance(vault_sol_account_pda);
    let amount = new anchor.BN(BCDEV/10000);

    await program.rpc.sellBcdev(    
        amount,
      {
        accounts: {     
          registrar:registrar.publicKey,
          memberSigner: memberAnnaSigner,
          poolMint,
          beneficiary: Anna.publicKey,
          member: memberAnna.publicKey,
          vaultSolAccount: vault_sol_account_pda,      
          vaultBcdev: memberAnnaBcdevVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,  
        },
        signers: [Anna],
      }
    );    
    
   let _vault_sol_after = await provider.connection.getBalance(vault_sol_account_pda);
   assert.ok(_vault_sol_before !=_vault_sol_after);      
   
  });
  
  // Creating bob member
  const Bob = anchor.web3.Keypair.generate();      
  const memberBob = anchor.web3.Keypair.generate();   
  let memberBobSigner = null;
  let memberBobVault = null;
  
  
  it("Creates a member Bob", async () => {
    let memberAccount = null;  
      
    // Airdropping tokens to a Bob.
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(Bob.publicKey, solAmount),
      "processed"
    );
    
    const [_memberSigner, nonce] =
      await anchor.web3.PublicKey.findProgramAddress(
        [registrar.publicKey.toBuffer(), memberBob.publicKey.toBuffer()],
        program.programId
      );
    memberBobSigner = _memberSigner;    
    memberBobVault = await serumCmn.createTokenAccount(provider, mint, memberBobSigner);
    

    const tx = program.transaction.createMember(nonce, false, {
      accounts: {
        registrar: registrar.publicKey,
        member: memberBob.publicKey,
        beneficiary: Bob.publicKey,
        memberSigner: memberBobSigner,        
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        systemProgram: anchor.web3.SystemProgram.programId,  
      },      
    });

    const signers = [memberBob, Bob];    
    const allTxs = [{ tx, signers }];
    let txSigs = await provider.sendAll(allTxs);

    memberAccount = await program.account.member.fetch(memberBob.publicKey);

    assert.isTrue(memberAccount.registrar.equals(registrar.publicKey));
    assert.isTrue(memberAccount.beneficiary.equals(Bob.publicKey));
    
    assert.ok(memberAccount.bought.toNumber()==0);     
    assert.ok(memberAccount.trusted.toNumber()==0);  
  });
  
  
  it("Buy 10 FCTR for Bob", async () => {
      
    let buyingAmount = new anchor.BN(10*FCTR);    
    
    await program.rpc.buyFctr(      
          buyingAmount,      
      {
        accounts: {          
          registrar:registrar.publicKey,
          registrarSigner,
          mint,
          buyer: Bob.publicKey,
          member: memberBob.publicKey,
          vaultSolAccount: vault_sol_account_pda,      
          vault: memberBobVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,  
        },
        signers: [Bob],
      }
    );    
  
   
   const memberVault = await serumCmn.getTokenAccount(
      provider,
      memberBobVault
    );
   
   assert.isTrue(memberVault.amount.eq(new anchor.BN(10*FCTR)));
  });
  
  // Creating Charlie member
  const Charlie = anchor.web3.Keypair.generate();      
  const memberCharlie = anchor.web3.Keypair.generate();    
  let memberCharlieSigner = null;
  let memberCharlieVault = null;  
  let memberCharlieBcdevVault = null;
  
  it("Creates a member Charlie", async () => {
    let memberAccount = null;  
      
    // Airdropping tokens to a Charlie.
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(Charlie.publicKey, solAmount),
      "processed"
    );
    
    const [_memberSigner, nonce] =
      await anchor.web3.PublicKey.findProgramAddress(
        [registrar.publicKey.toBuffer(), memberCharlie.publicKey.toBuffer()],
        program.programId
      );
    memberCharlieSigner = _memberSigner;    
    memberCharlieVault = await serumCmn.createTokenAccount(provider, mint, memberCharlieSigner);    
    memberCharlieBcdevVault = await serumCmn.createTokenAccount(provider, poolMint, memberCharlieSigner);  
    
    const tx = program.transaction.createMember(nonce, false, {
      accounts: {
        registrar: registrar.publicKey,
        member: memberCharlie.publicKey,
        beneficiary: Charlie.publicKey,
        memberSigner: memberCharlieSigner,        
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        systemProgram: anchor.web3.SystemProgram.programId,  
      },
      
    });

    const signers = [memberCharlie, Charlie];    
    const allTxs = [{ tx, signers }];
    let txSigs = await provider.sendAll(allTxs);

    memberAccount = await program.account.member.fetch(memberCharlie.publicKey);

    assert.isTrue(memberAccount.registrar.equals(registrar.publicKey));
    assert.isTrue(memberAccount.beneficiary.equals(Charlie.publicKey));
   
    assert.ok(memberAccount.bought.toNumber()==0);    
    assert.ok(memberAccount.trusted.toNumber()==0);  
  
  });
  
  
  it("Buy 15 FCTR for Charlie", async () => {
      
    let buyingAmount = new anchor.BN(15*FCTR);    
  
    await program.rpc.buyFctr(      
          buyingAmount,      
      {
        accounts: {          
          registrar:registrar.publicKey,
          registrarSigner,
          mint,
          buyer: Charlie.publicKey,
          member: memberCharlie.publicKey,
          vaultSolAccount: vault_sol_account_pda,      
          vault: memberCharlieVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,  
        },
        signers: [Charlie],
      }
    );  
    
     let memberAccount = await program.account.member.fetch(
      memberCharlie.publicKey
    );
   
   assert.isTrue(memberAccount.bought.eq(new anchor.BN(15*FCTR)));
   assert.isTrue(memberAccount.trusted.eq(new anchor.BN(0)));  
   assert.isTrue(memberAccount.staked.eq(new anchor.BN(0)));
   assert.isTrue(memberAccount.stakedTrusted.eq(new anchor.BN(0)));
   assert.isTrue(memberAccount.shared.eq(new anchor.BN(0)));
    
  });
  
  let AnnaToBobRound2Check = anchor.web3.Keypair.generate(); 
  
  it("Trust some amount to Bob by Anna", async () => {        
   
    const [_AnnaToBob, _nonce] =
      await anchor.web3.PublicKey.findProgramAddress(
        [Anna.publicKey.toBuffer(), memberBob.publicKey.toBuffer()],
        program.programId
      );
    let AnnaToBob = _AnnaToBob;   
    
    let amount = new anchor.BN(2*FCTR);
    
    await program.rpc.trustToMember( 
        
        amount,
      {
        accounts: {     
          registrar:registrar.publicKey,
          beneficiary: Anna.publicKey,
          memberWhoTrust: memberAnna.publicKey,
          memberWhoTrustSigner: memberAnnaSigner,
          memberWhoTrustFctrVault:memberAnnaVault,
          memberWhoTrustBcdevVault:memberAnnaBcdevVault,          
          memberToTrust: memberBob.publicKey,
          memberToTrustFctrVault:memberBobVault,
          memberToTrustSigner:memberBobSigner,          
          trustCheck: AnnaToBobRound2Check.publicKey,          
          registrarVault,
          round: round2.publicKey,                    
          trusterToMember:AnnaToBob,          
          clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,  
        },
        signers: [Anna, AnnaToBobRound2Check],
        instructions: [
          await program.account.trustCheck.createInstruction(AnnaToBobRound2Check),                        
        ],
      }
    );        
    
    const memberVault = await serumCmn.getTokenAccount(
      provider,
      memberBobVault
    );   
    assert.isTrue(memberVault.amount.eq(new anchor.BN(12*FCTR)));
   
    let memberAnnaAccount = await program.account.member.fetch(
         memberAnna.publicKey
    );   
    
    assert.isTrue(memberAnnaAccount.bought.eq(new anchor.BN(20*FCTR)));
    assert.isTrue(memberAnnaAccount.trusted.eq(new anchor.BN(0)));  
    assert.isTrue(memberAnnaAccount.staked.eq(new anchor.BN(0)));
    assert.isTrue(memberAnnaAccount.stakedTrusted.eq(new anchor.BN(0)));
    assert.isTrue(memberAnnaAccount.shared.eq(new anchor.BN(2*FCTR))); 
   
    
    let _memberAccount = await program.account.member.fetch(
         memberBob.publicKey
    );     
    assert.isTrue(_memberAccount.bought.eq(new anchor.BN(10*FCTR)));
    assert.isTrue(_memberAccount.trusted.eq(new anchor.BN(2*FCTR)));  
    assert.isTrue(_memberAccount.staked.eq(new anchor.BN(0)));
    assert.isTrue(_memberAccount.stakedTrusted.eq(new anchor.BN(0)));
    assert.isTrue(_memberAccount.shared.eq(new anchor.BN(0)));
    
    let pool_mem = _memberAccount.trustedPool[0];    
    assert.isTrue(pool_mem.memberWhoTrust.equals(memberAnna.publicKey));  
    assert.isTrue(pool_mem.trustedAmount.eq(new anchor.BN(2*FCTR)));
    
    let _checkAccount = await program.account.trustCheck.fetch(
         AnnaToBobRound2Check.publicKey
    );  
    assert.isTrue(_checkAccount.memberWhoTrust.equals(memberAnna.publicKey));
    assert.isTrue(_checkAccount.memberToTrust.equals(memberBob.publicKey));
    assert.isTrue(_checkAccount.amount.eq(new anchor.BN(2*FCTR))); 
    assert.isTrue(_checkAccount.round.equals(round2.publicKey));
    assert.isFalse(_checkAccount.burn);    
  });
  
  let CharlieToBobRound2Check = anchor.web3.Keypair.generate(); 
  let CharlieToBob=null;

  it("Trust some amount to Bob by Charlie", async () => {   
      
    const [_CharlieToBob, _nonce] =
      await anchor.web3.PublicKey.findProgramAddress(
        [Charlie.publicKey.toBuffer(), memberBob.publicKey.toBuffer()],
        program.programId
      );
    CharlieToBob = _CharlieToBob;    
    
    let amount = new anchor.BN(3*FCTR);
    
    await program.rpc.trustToMember(  
        
        amount,
      {
        accounts: {     
          registrar:registrar.publicKey,
          beneficiary: Charlie.publicKey,
          memberWhoTrust: memberCharlie.publicKey,
          memberWhoTrustSigner: memberCharlieSigner,
          memberWhoTrustFctrVault:memberCharlieVault,
          memberWhoTrustBcdevVault:memberCharlieBcdevVault,          
          memberToTrust: memberBob.publicKey,
          memberToTrustFctrVault:memberBobVault,
          memberToTrustSigner: memberBobSigner,          
          trustCheck: CharlieToBobRound2Check.publicKey,          
          registrarVault,
          round: round2.publicKey,          
          trusterToMember:CharlieToBob,          
          clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,  
        },
        signers: [Charlie, CharlieToBobRound2Check],
        instructions: [
          await program.account.trustCheck.createInstruction(CharlieToBobRound2Check),                        
        ],
      }
    );        
    
    const memberVault = await serumCmn.getTokenAccount(
      provider,
      memberCharlieVault
    );   
    assert.isTrue(memberVault.amount.eq(new anchor.BN(12*FCTR)));
   
    let memberCharlieAccount = await program.account.member.fetch(
         memberCharlie.publicKey
    );   
    
    assert.isTrue(memberCharlieAccount.bought.eq(new anchor.BN(15*FCTR)));
    assert.isTrue(memberCharlieAccount.trusted.eq(new anchor.BN(0)));  
    assert.isTrue(memberCharlieAccount.staked.eq(new anchor.BN(0)));
    assert.isTrue(memberCharlieAccount.stakedTrusted.eq(new anchor.BN(0)));
    assert.isTrue(memberCharlieAccount.shared.eq(new anchor.BN(3*FCTR))); 
   
    
    let _memberAccount = await program.account.member.fetch(
         memberBob.publicKey
    );     
    assert.isTrue(_memberAccount.bought.eq(new anchor.BN(10*FCTR)));
    assert.isTrue(_memberAccount.trusted.eq(new anchor.BN(5*FCTR)));  
    assert.isTrue(_memberAccount.staked.eq(new anchor.BN(0)));
    assert.isTrue(_memberAccount.stakedTrusted.eq(new anchor.BN(0)));
    assert.isTrue(_memberAccount.shared.eq(new anchor.BN(0)));
    
    let pool_mem = _memberAccount.trustedPool[0];    
    assert.isTrue(pool_mem.memberWhoTrust.equals(memberAnna.publicKey));      
    assert.isTrue(pool_mem.trustedAmount.eq(new anchor.BN(2*FCTR)));
    
    let pool_mem_2 = _memberAccount.trustedPool[1];    
    assert.isTrue(pool_mem_2.memberWhoTrust.equals(memberCharlie.publicKey));      
    assert.isTrue(pool_mem_2.trustedAmount.eq(new anchor.BN(3*FCTR)));
    
    let _checkAccount = await program.account.trustCheck.fetch(
         CharlieToBobRound2Check.publicKey
    );  
    assert.isTrue(_checkAccount.memberWhoTrust.equals(memberCharlie.publicKey));
    assert.isTrue(_checkAccount.memberToTrust.equals(memberBob.publicKey));
    assert.isTrue(_checkAccount.amount.eq(new anchor.BN(3*FCTR))); 
    assert.isTrue(_checkAccount.round.equals(round2.publicKey));
    assert.isFalse(_checkAccount.burn);    
  });
  
  
  it("Bob Stake's to round 2 with shared tokens", async () => {  

    await program.rpc.stake(            
      {
        accounts: {     
           registrar: registrar.publicKey,           
           registrarVault,
           poolMint,
           beneficiary: Bob.publicKey,
           member: memberBob.publicKey,
           memberSigner: memberBobSigner,
           memberFctrVault: memberBobVault,
           round: round2.publicKey,
           clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
           tokenProgram: TOKEN_PROGRAM_ID,
           systemProgram: anchor.web3.SystemProgram.programId,            
        },
        signers: [Bob],
      }
    );        
    
    const memberVault = await serumCmn.getTokenAccount(
      provider,
      memberBobVault
    );
    
    assert.isTrue(memberVault.amount.eq(new anchor.BN(0)));
   
    let memberAccount = await program.account.member.fetch(
      memberBob.publicKey
    );
    assert.isTrue(memberAccount.bought.eq(new anchor.BN(0)));
    assert.isTrue(memberAccount.trusted.eq(new anchor.BN(0)));  
    assert.isTrue(memberAccount.staked.eq(new anchor.BN(10*FCTR)));
    assert.isTrue(memberAccount.stakedTrusted.eq(new anchor.BN(5*FCTR)));
    assert.isTrue(memberAccount.shared.eq(new anchor.BN(0)));       
    assert.isTrue(memberAccount.reward.gt(new anchor.BN(0)));    
  });
    
  it("Waits for the lockup period to pass", async () => {
    await serumCmn.sleep(10 * 1000);
  }); 
  
  const round3 = anchor.web3.Keypair.generate();    
  
  it("Create round 3", async () => {
    let final_round = false;
      
    await program.rpc.startRound(    
        final_round,
      {
        accounts: {     
           registrar: registrar.publicKey,
           authority: provider.wallet.publicKey,
           round: round3.publicKey,           
           clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
           systemProgram: anchor.web3.SystemProgram.programId,            
        },
        signers: [round3],
        instructions: [
          await program.account.round.createInstruction(round3),                        
        ],
      }
    );    
    
    let roundAccount = await program.account.round.fetch(
      round3.publicKey
    );
    
    assert.isTrue(roundAccount.registrar.equals(registrar.publicKey));
    assert.strictEqual(roundAccount.number, 3);
    assert.ok(roundAccount.finalRound==false);          
  });
  
  let memberBobBcdevVault = null;
  
   
  it("Unstake from round 2", async () => {         
    
    memberBobBcdevVault = await serumCmn.createTokenAccount(provider, poolMint, memberBobSigner);  
    
    let memberBcdevCharlieVault_before = await serumCmn.getTokenAccount(
        provider,
        memberCharlieBcdevVault
    );
    
    let memberAnnaVault_before = await serumCmn.getTokenAccount(
        provider,
        memberAnnaVault
    );
   
    await program.rpc.unstake(            
      {
        accounts: {     
           registrar: registrar.publicKey,
           registrarSigner,
           registrarVault,           
           poolMint,
           beneficiary: Bob.publicKey,
           member: memberBob.publicKey,           
           memberFctrVault: memberBobVault,
           memberBcdevVault: memberBobBcdevVault,
           round: round2.publicKey,           
           clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
           tokenProgram: TOKEN_PROGRAM_ID,
           systemProgram: anchor.web3.SystemProgram.programId,            
        },
        signers: [Bob],
        remainingAccounts: [
            {pubkey:memberAnnaVault , isWritable: true , isSigner: false},
            {pubkey:memberAnnaBcdevVault , isWritable: true , isSigner: false},
            {pubkey:memberCharlieVault , isWritable: true , isSigner: false},
            {pubkey:memberCharlieBcdevVault , isWritable: true , isSigner: false},
        ]        
      }
    );        
    
    const memberVault = await serumCmn.getTokenAccount(
      provider,
      memberBobVault
    );  
    assert.isTrue(memberVault.amount.eq(new anchor.BN(10*FCTR)));
   
    let _memberAccount = await program.account.member.fetch(
      memberBob.publicKey
    );
    assert.isTrue(_memberAccount.bought.eq(new anchor.BN(10*FCTR)));
    assert.isTrue(_memberAccount.trusted.eq(new anchor.BN(0)));  
    assert.isTrue(_memberAccount.staked.eq(new anchor.BN(0)));
    assert.isTrue(_memberAccount.stakedTrusted.eq(new anchor.BN(0)));
    assert.isTrue(_memberAccount.shared.eq(new anchor.BN(0)));
    
    let pool = _memberAccount.trustedPool;    
    assert.ok(pool.length==0);     
    
    assert.isTrue(_memberAccount.reward.eq(new anchor.BN(0)));
    
    let memberAnnaAccount = await program.account.member.fetch(
         memberAnna.publicKey
    );   
    
    assert.isTrue(memberAnnaAccount.bought.eq(new anchor.BN(20*FCTR)));
    assert.isTrue(memberAnnaAccount.trusted.eq(new anchor.BN(0)));  
    assert.isTrue(memberAnnaAccount.staked.eq(new anchor.BN(0)));
    assert.isTrue(memberAnnaAccount.stakedTrusted.eq(new anchor.BN(0)));    
    assert.isTrue(memberAnnaAccount.shared.eq(new anchor.BN(2*FCTR)));    
   
    let memberBcdevVault_after = await serumCmn.getTokenAccount(
       provider,
       memberBobBcdevVault
     );
    
    assert.isTrue(memberBcdevVault_after.amount.gt(new anchor.BN(0)));
    
     let memberAnnaVault_after = await serumCmn.getTokenAccount(
        provider,
        memberAnnaVault
    );    
    assert.ok(memberAnnaVault_before.amount.toNumber()+2*FCTR == memberAnnaVault_after.amount.toNumber());
   
    let memberBcdevCharlieVault_after = await serumCmn.getTokenAccount(
        provider,
        memberCharlieBcdevVault
    );   
    assert.isTrue(memberBcdevCharlieVault_after.amount.
   gt(memberBcdevCharlieVault_before.amount));
    
  });
  
  
  it("Check unstaked Bob by Anna", async () => {    
    
    await program.rpc.checkUnstaked(           
      {
        accounts: {     
          registrar:registrar.publicKey,                   
          round: round2.publicKey,
          memberToTrust: memberBob.publicKey,
          beneficiary: Anna.publicKey, 
          memberWhoTrust: memberAnna.publicKey,      
          trustCheck: AnnaToBobRound2Check.publicKey,         
        },
        signers: [Anna],        
      }
    );    
    
     let memberAnnaAccount = await program.account.member.fetch(
         memberAnna.publicKey
    );   
    
    assert.isTrue(memberAnnaAccount.bought.eq(new anchor.BN(20*FCTR)));
    assert.isTrue(memberAnnaAccount.trusted.eq(new anchor.BN(0)));  
    assert.isTrue(memberAnnaAccount.staked.eq(new anchor.BN(0)));
    assert.isTrue(memberAnnaAccount.stakedTrusted.eq(new anchor.BN(0)));    
    assert.isTrue(memberAnnaAccount.shared.eq(new anchor.BN(0))); 
    
    let _checkAccount = await program.account.trustCheck.fetch(
         AnnaToBobRound2Check.publicKey
    );      
    assert.isTrue(_checkAccount.burn);
  });
  
  
  it("Check unstaked Bob by Charlie", async () => {   
    
    await program.rpc.checkUnstaked(            
      {
        accounts: {     
          registrar:registrar.publicKey,                   
          round: round2.publicKey,
          memberToTrust: memberBob.publicKey,
          beneficiary: Charlie.publicKey, 
          memberWhoTrust: memberCharlie.publicKey,      
          trustCheck: CharlieToBobRound2Check.publicKey,         
        },
        signers: [Charlie],        
      }
    );    
    
     let memberAccount = await program.account.member.fetch(
         memberCharlie.publicKey
    );   
    
    assert.isTrue(memberAccount.bought.eq(new anchor.BN(15*FCTR)));
    assert.isTrue(memberAccount.trusted.eq(new anchor.BN(0)));  
    assert.isTrue(memberAccount.staked.eq(new anchor.BN(0)));
    assert.isTrue(memberAccount.stakedTrusted.eq(new anchor.BN(0)));    
    assert.isTrue(memberAccount.shared.eq(new anchor.BN(0))); 
    
    let _checkAccount = await program.account.trustCheck.fetch(
         CharlieToBobRound2Check.publicKey
    );      
    assert.isTrue(_checkAccount.burn);  
   
  });  
  
  
  it("Anna transfer FCTR without sharing program", async () => {
      
    let amount = new anchor.BN(5*FCTR); 
    
    await program.rpc.transferFctr(    
        amount,
      {
        accounts: {     
          registrar:registrar.publicKey,
          memberSigner: memberAnnaSigner,          
          beneficiary: Anna.publicKey,
          member: memberAnna.publicKey,          
          vaultFctr: memberAnnaVault,
          tokenHolder: memberCharlieVault,          
          tokenProgram: TOKEN_PROGRAM_ID,          
        },
        signers: [Anna],
      }
    );        
   
   let memberVault_after = await serumCmn.getTokenAccount(
      provider,
      memberAnnaVault
    );   
   assert.isTrue(memberVault_after.amount.eq(new anchor.BN(15*FCTR)));
   
   let memberAnnaAccount = await program.account.member.fetch(
         memberAnna.publicKey
    );   
    //console.log(memberAnnaAccount.bought.toNumber());
    assert.isTrue(memberAnnaAccount.bought.eq(new anchor.BN(15*FCTR)));
    assert.isTrue(memberAnnaAccount.trusted.eq(new anchor.BN(0)));  
    assert.isTrue(memberAnnaAccount.staked.eq(new anchor.BN(0)));
    assert.isTrue(memberAnnaAccount.stakedTrusted.eq(new anchor.BN(0)));
    assert.isTrue(memberAnnaAccount.shared.eq(new anchor.BN(0))); 
  });
  
  
  it("Charlie Stake's to round 3", async () => {  

    await program.rpc.stake(            
      {
        accounts: {     
           registrar: registrar.publicKey,           
           registrarVault,
           poolMint,
           beneficiary: Charlie.publicKey,
           member: memberCharlie.publicKey,
           memberSigner: memberCharlieSigner,
           memberFctrVault: memberCharlieVault,           
           round: round3.publicKey,           
           clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
           tokenProgram: TOKEN_PROGRAM_ID,
           systemProgram: anchor.web3.SystemProgram.programId,  
          
        },
        signers: [Charlie],
      }
    );    
    
    let memberAccount = await program.account.member.fetch(
      memberCharlie.publicKey
    );
    assert.isTrue(memberAccount.bought.eq(new anchor.BN(0)));
    assert.isTrue(memberAccount.trusted.eq(new anchor.BN(0)));  
    assert.isTrue(memberAccount.staked.eq(new anchor.BN(15*FCTR)));
    assert.isTrue(memberAccount.stakedTrusted.eq(new anchor.BN(0)));
    assert.isTrue(memberAccount.shared.eq(new anchor.BN(0))); 
    assert.isTrue(memberAccount.reward.gt(new anchor.BN(0)));
  });
  
  let BobToCharlieRound3Check = anchor.web3.Keypair.generate();    
   
  it("Trust some amount to Charlie by Bob that stakes automaticaly", async () => {      
    
    const [_BobToCharlie, _nonce] =
      await anchor.web3.PublicKey.findProgramAddress(
        [Bob.publicKey.toBuffer(), memberCharlie.publicKey.toBuffer()],
        program.programId
      );
    let BobToCharlie = _BobToCharlie;
    let amount = new anchor.BN(2*FCTR);
    
    await program.rpc.trustToMember(    
        amount,
      {
        accounts: {     
          registrar:registrar.publicKey,
          beneficiary: Bob.publicKey,
          memberWhoTrust: memberBob.publicKey,
          memberWhoTrustSigner: memberBobSigner,
          memberWhoTrustFctrVault:memberBobVault,
          memberWhoTrustBcdevVault:memberBobBcdevVault,          
          memberToTrust: memberCharlie.publicKey,
          memberToTrustFctrVault:memberCharlieVault,
          memberToTrustSigner:memberCharlieSigner,          
          trustCheck: BobToCharlieRound3Check.publicKey,          
          registrarVault,
          round: round3.publicKey,          
          trusterToMember:BobToCharlie,          
          clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,  
        },
        signers: [Bob,BobToCharlieRound3Check],
        instructions: [
          await program.account.trustCheck.createInstruction(BobToCharlieRound3Check),                        
        ],
        
      }
    );    
    
    let _memberAccount = await program.account.member.fetch(
         memberBob.publicKey
    );     
    assert.isTrue(_memberAccount.bought.eq(new anchor.BN(10*FCTR)));
    assert.isTrue(_memberAccount.trusted.eq(new anchor.BN(0)));  
    assert.isTrue(_memberAccount.staked.eq(new anchor.BN(0)));
    assert.isTrue(_memberAccount.stakedTrusted.eq(new anchor.BN(0)));
    assert.isTrue(_memberAccount.shared.eq(new anchor.BN(2*FCTR)));
    
    let memberCharlieAccount = await program.account.member.fetch(
         memberCharlie.publicKey
    );   
    
    assert.isTrue(memberCharlieAccount.bought.eq(new anchor.BN(0)));
    assert.isTrue(memberCharlieAccount.trusted.eq(new anchor.BN(0)));  
    assert.isTrue(memberCharlieAccount.staked.eq(new anchor.BN(15*FCTR)));
    assert.isTrue(memberCharlieAccount.stakedTrusted.eq(new anchor.BN(2*FCTR)));
    assert.isTrue(memberCharlieAccount.shared.eq(new anchor.BN(0))); 
    
    let pool_mem = memberCharlieAccount.trustedPool[0];    
    assert.isTrue(pool_mem.memberWhoTrust.equals(memberBob.publicKey));  
    assert.isTrue(pool_mem.trustedAmount.eq(new anchor.BN(2*FCTR)));
    
    let _checkAccount = await program.account.trustCheck.fetch(
         BobToCharlieRound3Check.publicKey
    );  
    assert.isTrue(_checkAccount.memberWhoTrust.equals(memberBob.publicKey));
    assert.isTrue(_checkAccount.memberToTrust.equals(memberCharlie.publicKey));
    assert.isTrue(_checkAccount.amount.eq(new anchor.BN(2*FCTR))); 
    assert.isTrue(_checkAccount.round.equals(round3.publicKey));
    assert.isFalse(_checkAccount.burn);
   
  });
  
  let BobToAnnaRound3Check = anchor.web3.Keypair.generate();    
   
  it("Trust some amount to Anna by Bob ", async () => {          
    
    const [_BobToAnna, _nonce] =
      await anchor.web3.PublicKey.findProgramAddress(
        [Bob.publicKey.toBuffer(), memberAnna.publicKey.toBuffer()],
        program.programId
      );
    let BobToAnna = _BobToAnna;   
    let amount = new anchor.BN(2*FCTR);
    
    await program.rpc.trustToMember(    
        amount,
      {
        accounts: {     
          registrar:registrar.publicKey,
          beneficiary: Bob.publicKey,
          memberWhoTrust: memberBob.publicKey,
          memberWhoTrustSigner: memberBobSigner,
          memberWhoTrustFctrVault:memberBobVault,
          memberWhoTrustBcdevVault:memberBobBcdevVault,          
          memberToTrust: memberAnna.publicKey,
          memberToTrustFctrVault:memberAnnaVault,
          memberToTrustSigner:memberAnnaSigner,          
          trustCheck: BobToAnnaRound3Check.publicKey,          
          registrarVault,
          round: round3.publicKey,          
          trusterToMember:BobToAnna,          
          clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,  
        },
        signers: [Bob,BobToAnnaRound3Check],
        instructions: [
          await program.account.trustCheck.createInstruction(BobToAnnaRound3Check),                                      
        ],
      }
    );        
    
    let memberBobAccount = await program.account.member.fetch(
         memberBob.publicKey
    );   
    
    assert.isTrue(memberBobAccount.bought.eq(new anchor.BN(10*FCTR)));
    assert.isTrue(memberBobAccount.trusted.eq(new anchor.BN(0)));  
    assert.isTrue(memberBobAccount.staked.eq(new anchor.BN(0)));
    assert.isTrue(memberBobAccount.stakedTrusted.eq(new anchor.BN(0)));    
    assert.isTrue(memberBobAccount.shared.eq(new anchor.BN(4*FCTR)));    
    
    let _memberAccount = await program.account.member.fetch(
         memberAnna.publicKey
    );     
    assert.isTrue(_memberAccount.bought.eq(new anchor.BN(15*FCTR)));
    assert.isTrue(_memberAccount.trusted.eq(new anchor.BN(2*FCTR)));  
    assert.isTrue(_memberAccount.staked.eq(new anchor.BN(0)));
    assert.isTrue(_memberAccount.stakedTrusted.eq(new anchor.BN(0)));
    assert.isTrue(_memberAccount.shared.eq(new anchor.BN(0)));
    
    let pool_mem = _memberAccount.trustedPool[0];    
    assert.isTrue(pool_mem.memberWhoTrust.equals(memberBob.publicKey));  
    assert.isTrue(pool_mem.trustedAmount.eq(new anchor.BN(2*FCTR)));
    
    let _checkAccount = await program.account.trustCheck.fetch(
         BobToAnnaRound3Check.publicKey
    );  
    assert.isTrue(_checkAccount.memberWhoTrust.equals(memberBob.publicKey));
    assert.isTrue(_checkAccount.memberToTrust.equals(memberAnna.publicKey));
    assert.isTrue(_checkAccount.amount.eq(new anchor.BN(2*FCTR))); 
    assert.isTrue(_checkAccount.round.equals(round3.publicKey));
    assert.isFalse(_checkAccount.burn);        
  });
  
  let  AnnaToCharlieRound3Check = anchor.web3.Keypair.generate();    
  
  it("Trust some amount to Charlie by Anna that stakes automaticaly", async () => {  
      
    const [_AnnaToCharlie, _nonce] =
      await anchor.web3.PublicKey.findProgramAddress(
        [Anna.publicKey.toBuffer(), memberCharlie.publicKey.toBuffer()],
        program.programId
      );
    let AnnaToCharlie = _AnnaToCharlie;      
      
    let amount = new anchor.BN(3*FCTR);
    
    await program.rpc.trustToMember(    
        amount,
      {
        accounts: {     
          registrar:registrar.publicKey,
          beneficiary: Anna.publicKey,
          memberWhoTrust: memberAnna.publicKey,
          memberWhoTrustSigner: memberAnnaSigner,
          memberWhoTrustFctrVault:memberAnnaVault,
          memberWhoTrustBcdevVault:memberAnnaBcdevVault,          
          memberToTrust: memberCharlie.publicKey,
          memberToTrustFctrVault:memberCharlieVault,
          memberToTrustSigner: memberCharlieSigner,          
          trustCheck: AnnaToCharlieRound3Check.publicKey,          
          registrarVault,
          round: round3.publicKey,          
          trusterToMember:AnnaToCharlie,          
          clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,  
        },
        signers: [Anna, AnnaToCharlieRound3Check],
        instructions: [
          await program.account.trustCheck.createInstruction(AnnaToCharlieRound3Check),                        
        ],
      }
    );        
    
    let memberAnnaAccount = await program.account.member.fetch(
         memberAnna.publicKey
    );   
    
    assert.isTrue(memberAnnaAccount.bought.eq(new anchor.BN(15*FCTR)));    
    assert.isTrue(memberAnnaAccount.trusted.eq(new anchor.BN(2*FCTR)));  
    assert.isTrue(memberAnnaAccount.staked.eq(new anchor.BN(0)));
    assert.isTrue(memberAnnaAccount.stakedTrusted.eq(new anchor.BN(0)));
    assert.isTrue(memberAnnaAccount.shared.eq(new anchor.BN(3*FCTR)));    
    
    let _memberAccount = await program.account.member.fetch(
         memberCharlie.publicKey
    );     
    assert.isTrue(_memberAccount.bought.eq(new anchor.BN(0)));
    assert.isTrue(_memberAccount.trusted.eq(new anchor.BN(0)));  
    assert.isTrue(_memberAccount.staked.eq(new anchor.BN(15*FCTR)));
    assert.isTrue(_memberAccount.stakedTrusted.eq(new anchor.BN(5*FCTR)));
    assert.isTrue(_memberAccount.shared.eq(new anchor.BN(0)));
    
    let pool_mem = _memberAccount.trustedPool[0];    
    assert.isTrue(pool_mem.memberWhoTrust.equals(memberBob.publicKey));  
    assert.isTrue(pool_mem.trustedAmount.eq(new anchor.BN(2*FCTR)));
    
    let pool_mem2= _memberAccount.trustedPool[1];    
    assert.isTrue(pool_mem2.memberWhoTrust.equals(memberAnna.publicKey));  
    assert.isTrue(pool_mem2.trustedAmount.eq(new anchor.BN(3*FCTR)));
    
    let _checkAccount = await program.account.trustCheck.fetch(
         AnnaToCharlieRound3Check.publicKey
    );  
    assert.isTrue(_checkAccount.memberWhoTrust.equals(memberAnna.publicKey));
    assert.isTrue(_checkAccount.memberToTrust.equals(memberCharlie.publicKey));
    assert.isTrue(_checkAccount.amount.eq(new anchor.BN(3*FCTR))); 
    assert.isTrue(_checkAccount.round.equals(round3.publicKey));
    assert.isFalse(_checkAccount.burn);
  });
   
   it("Anna take back shared tokens and give shared to him", async () => {     
    
    await program.rpc.exitSharing(            
      {
        accounts: {     
          registrar:registrar.publicKey,
          registrarSigner,
          registrarVault,
          beneficiary: Anna.publicKey,
          memberWhoTrust: memberAnna.publicKey,
          memberWhoTrustSigner: memberAnnaSigner,
          memberWhoTrustFctrVault:memberAnnaVault,
          memberWhoTrustBcdevVault:memberAnnaBcdevVault,          
          memberToTrust: memberCharlie.publicKey,
          memberToTrustFctrVault:memberCharlieVault,
          memberToTrustSigner: memberCharlieSigner,          
          trustCheck: AnnaToCharlieRound3Check.publicKey,          
          round: round3.publicKey,          
          clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,          
        },
        signers: [Anna],
        remainingAccounts: [
            {pubkey:memberBobVault , isWritable: true , isSigner: false},
        ]
      }
    );    
    
    let memberBobAccount = await program.account.member.fetch(
         memberBob.publicKey
    );   
    
    assert.isTrue(memberBobAccount.bought.eq(new anchor.BN(10*FCTR)));    
    assert.isTrue(memberBobAccount.trusted.eq(new anchor.BN(0)));  
    assert.isTrue(memberBobAccount.staked.eq(new anchor.BN(0)));
    assert.isTrue(memberBobAccount.stakedTrusted.eq(new anchor.BN(0)));
    assert.isTrue(memberBobAccount.shared.eq(new anchor.BN(4*FCTR)));    
    
    let memberAnnaAccount = await program.account.member.fetch(
         memberAnna.publicKey
    );   
    
    assert.isTrue(memberAnnaAccount.bought.eq(new anchor.BN(15*FCTR)));       
    assert.isTrue(memberAnnaAccount.trusted.eq(new anchor.BN(0)));  
    assert.isTrue(memberAnnaAccount.staked.eq(new anchor.BN(0)));
    assert.isTrue(memberAnnaAccount.stakedTrusted.eq(new anchor.BN(0)));
    assert.isTrue(memberAnnaAccount.shared.eq(new anchor.BN(0))); 
    
    let poolC = memberAnnaAccount.trustedPool;
    assert.ok(poolC.length==0);   
    
    let _memberAccount = await program.account.member.fetch(
         memberCharlie.publicKey
    );     
    assert.isTrue(_memberAccount.bought.eq(new anchor.BN(0)));
    assert.isTrue(_memberAccount.trusted.eq(new anchor.BN(0)));  
    assert.isTrue(_memberAccount.staked.eq(new anchor.BN(15*FCTR)));
    assert.isTrue(_memberAccount.stakedTrusted.eq(new anchor.BN(2*FCTR)));
    assert.isTrue(_memberAccount.shared.eq(new anchor.BN(0)));
    
    let pool_memB = _memberAccount.trustedPool[0];    
    assert.isTrue(pool_memB.memberWhoTrust.equals(memberBob.publicKey));  
    assert.isTrue(pool_memB.trustedAmount.eq(new anchor.BN(2*FCTR)));
    
    let poolB = _memberAccount.trustedPool;
    assert.ok(poolB.length==1);
    
    let _checkAccount = await program.account.trustCheck.fetch(
         AnnaToCharlieRound3Check.publicKey
    );     
    assert.isTrue(_checkAccount.burn);
   
  });
   
   
  
  it("Check exit Anna by Bob", async () => {   
    
    await program.rpc.checkExit(            
      {
        accounts: {     
          registrar:registrar.publicKey,                   
          round: round3.publicKey,
          memberToTrust: memberAnna.publicKey,
          beneficiary: Bob.publicKey, 
          memberWhoTrust: memberBob.publicKey,      
          trustCheck: BobToAnnaRound3Check.publicKey,         
        },
        signers: [Bob],        
      }
    );    
    
     let memberBobAccount = await program.account.member.fetch(
         memberBob.publicKey
    );   
    
    assert.isTrue(memberBobAccount.bought.eq(new anchor.BN(10*FCTR)));
    assert.isTrue(memberBobAccount.trusted.eq(new anchor.BN(0)));  
    assert.isTrue(memberBobAccount.staked.eq(new anchor.BN(0)));
    assert.isTrue(memberBobAccount.stakedTrusted.eq(new anchor.BN(0)));    
    assert.isTrue(memberBobAccount.shared.eq(new anchor.BN(2*FCTR))); 
    
    let _checkAccount = await program.account.trustCheck.fetch(
         BobToAnnaRound3Check.publicKey
    );      
    assert.isTrue(_checkAccount.burn);  
   
  });   
  
  it("Waits for the lockup period to pass", async () => {
    await serumCmn.sleep(10 * 1000);
  }); 
  
  const round4 = anchor.web3.Keypair.generate();    
  
  it("Create final round 4", async () => {
      let final_round = true;
      
    await program.rpc.startRound(    
        final_round,
      {
        accounts: {     
           registrar: registrar.publicKey,
           authority: provider.wallet.publicKey,
           round: round4.publicKey,           
           clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
           systemProgram: anchor.web3.SystemProgram.programId,            
        },
        signers: [round4],
        instructions: [
          await program.account.round.createInstruction(round4),                        
        ],
      }
    );    
    
    let roundAccount = await program.account.round.fetch(
      round4.publicKey
    );
    
    assert.isTrue(roundAccount.registrar.equals(registrar.publicKey));
    assert.strictEqual(roundAccount.number, 4);
    assert.ok(roundAccount.finalRound==true);   
  });
  
   
  it("Unstake from round 3", async () => {         
    
    memberCharlieBcdevVault = await serumCmn.createTokenAccount(provider, poolMint, memberCharlieSigner);  
   
    await program.rpc.unstake(            
      {
        accounts: {     
           registrar: registrar.publicKey,
           registrarSigner,
           registrarVault,           
           poolMint,
           beneficiary: Charlie.publicKey,
           member: memberCharlie.publicKey,           
           memberFctrVault: memberCharlieVault,
           memberBcdevVault: memberCharlieBcdevVault,
           round: round3.publicKey,           
           clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
           tokenProgram: TOKEN_PROGRAM_ID,
           systemProgram: anchor.web3.SystemProgram.programId,            
        },
        signers: [Charlie],
        remainingAccounts: [
            {pubkey:memberBobVault , isWritable: true , isSigner: false},
            {pubkey:memberBobBcdevVault , isWritable: true , isSigner: false},            
        ]
        
      }
    );        
    
    let _memberAccount = await program.account.member.fetch(
      memberCharlie.publicKey
    );
    assert.isTrue(_memberAccount.bought.eq(new anchor.BN(15*FCTR)));
    assert.isTrue(_memberAccount.trusted.eq(new anchor.BN(0)));  
    assert.isTrue(_memberAccount.staked.eq(new anchor.BN(0)));
    assert.isTrue(_memberAccount.stakedTrusted.eq(new anchor.BN(0)));
    assert.isTrue(_memberAccount.shared.eq(new anchor.BN(0)));
    
    let pool = _memberAccount.trustedPool;    
    assert.ok(pool.length==0);     
    
    assert.isTrue(_memberAccount.reward.eq(new anchor.BN(0)));
    
    let memberBobAccount = await program.account.member.fetch(
         memberBob.publicKey
    );   
    
    assert.isTrue(memberBobAccount.bought.eq(new anchor.BN(10*FCTR)));
    assert.isTrue(memberBobAccount.trusted.eq(new anchor.BN(0)));  
    assert.isTrue(memberBobAccount.staked.eq(new anchor.BN(0)));
    assert.isTrue(memberBobAccount.stakedTrusted.eq(new anchor.BN(0)));    
    assert.isTrue(memberBobAccount.shared.eq(new anchor.BN(2*FCTR)));    
   
    let memberAccount = await program.account.member.fetch(
      memberCharlie.publicKey
    );   
    assert.isTrue(memberAccount.reward.eq(new anchor.BN(0)));    
  });
    
  
  it("Check unstaked Charlie by Bob", async () => {     
   
    
    await program.rpc.checkUnstaked(
      {
        accounts: {     
          registrar:registrar.publicKey,                   
          round: round3.publicKey,
          memberToTrust: memberCharlie.publicKey,
          beneficiary: Bob.publicKey, 
          memberWhoTrust: memberBob.publicKey,      
          trustCheck: BobToCharlieRound3Check.publicKey,         
        },
        signers: [Bob],
        
      }
    );    
    
     let memberBobAccount = await program.account.member.fetch(
         memberBob.publicKey
    );   
    
    assert.isTrue(memberBobAccount.bought.eq(new anchor.BN(10*FCTR)));
    assert.isTrue(memberBobAccount.trusted.eq(new anchor.BN(0)));  
    assert.isTrue(memberBobAccount.staked.eq(new anchor.BN(0)));
    assert.isTrue(memberBobAccount.stakedTrusted.eq(new anchor.BN(0)));     
    assert.isTrue(memberBobAccount.shared.eq(new anchor.BN(0))); 
    
    let _checkAccount = await program.account.trustCheck.fetch(
         BobToCharlieRound3Check.publicKey
    );      
    assert.isTrue(_checkAccount.burn);
   
  });
  
  
  it("Waits for the lockup period to pass", async () => {
    await serumCmn.sleep(10 * 1000);
  }); 
  
  
  it("Waits for the second lockup period to pass", async () => {
    await serumCmn.sleep(10 * 1000);
  }); 
  
  it("Waits for the third lockup period to pass", async () => {
    await serumCmn.sleep(10 * 1000);
  }); 
  
  
  it("Withdraw lamports", async () => {    
      
    await program.rpc.withdrawLamports(            
      {
        accounts: {     
          registrar:registrar.publicKey,                   
          round: round4.publicKey,
          mint,
          poolMint,
          authority: provider.wallet.publicKey,
          vaultSolAccount: vault_sol_account_pda,      
          clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
          systemProgram: anchor.web3.SystemProgram.programId,  
        },
        signers: [],        
      }
    );    
    
    let _vault_sol_after = await provider.connection.getBalance(vault_sol_account_pda);
    assert.ok(_vault_sol_after==0);   
  });   
  
});
