# More of Dots Leaderboard Worker

Free-tier Cloudflare Worker + D1 backend for the public leaderboard.

## Setup

1. Create a D1 database:

   ```powershell
   npx wrangler d1 create more-of-dots-leaderboard
   ```

2. Put the returned `database_id` into `wrangler.toml`.
3. Set a verifier pepper:

   ```powershell
   npx wrangler secret put CLAIM_PEPPER
   ```

4. Apply migrations and deploy:

   ```powershell
   npm install
   npm run db:migrate
   npm run deploy
   ```

5. Point the desktop app at the Worker:

   ```powershell
   $env:WOD_LEADERBOARD_URL="https://more-of-dots-leaderboard.<your-subdomain>.workers.dev"
   ```

The app never uploads the War of Dots password. It derives a local claim token from the configured username/password, and the Worker stores only a hash verifier for that token.
