const { initiateDeveloperControlledWalletsClient } = require('@circle-fin/developer-controlled-wallets');

const client = initiateDeveloperControlledWalletsClient({
  apiKey: 'TEST_API_KEY:d4955e8abc512e447955378e33e06629:8601ea37f0b1c4b359ee4a6bcf7571c3',
  entitySecret: 'b619786c1beb30d143459bfdb1d3c49c923fb5547860a956c13ea73dbc3e092f',
});

async function main() {
  const response = await client.createWalletSet({
    name: 'AgentForge',
  });

  const walletSet = response.data?.walletSet;
  console.log('\n✓ Wallet Set Created!');
  console.log('================================');
  console.log('WALLET SET ID:', walletSet?.id);
  console.log('================================');
  console.log('\nAdd this to your .env as CIRCLE_WALLET_SET_ID=', walletSet?.id);
}

main().catch(console.error);