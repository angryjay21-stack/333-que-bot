# 333 PVP League Bot

A complete premium ranked-league system for Discord with 1v1 and 2v2 matchmaking, normal and wager queues, private match channels, winner assignment, points, automatic rank roles, nicknames, player stats, and a live Top 10 leaderboard.

## Main features

- Premium red-and-black 333 PVP branding.
- 1v1 Normal and Wager queues.
- 2v2 Normal and Wager queues.
- 2v2 teammate ID modal.
- Automatic private match channels.
- Team 1 and Team 2 display.
- Correct League Admin or Wager Admin access.
- Request Admin button with private admin DMs and a direct match link.
- Assign Winner control restricted to the correct admin role.
- Winners receive +20 points each.
- Losers lose 20 points each, never below zero.
- Match channel deletes 10 seconds after completion.
- Player stats button and `/stats`.
- Top 10 leaderboard refreshes every 5 minutes.
- Nicknames refresh every minute: `(150) PlayerName`.
- Rank roles update automatically whenever points change.
- SQLite persistence.
- Railway health endpoint.
- GitHub-ready flat project structure.

## Exact rank system

| Points | Rank |
|---:|---|
| 0–199 | Bronze |
| 200–399 | Silver |
| 400–649 | Gold |
| 650–899 | Platinum |
| 900–1149 | Emerald |
| 1150–1399 | Diamond |
| 1400–1599 | Master |
| 1600–1799 | Grandmaster |
| 1800–1949 | Elite |
| 1950+ | Legend |

When a player crosses into a new rank, the bot removes their previous rank role and gives them the correct new role.

## Discord channels needed

Create:

1. League information/stats channel
2. 1v1 queue channel
3. 2v2 queue channel
4. Match category
5. Leaderboard channel

## Discord roles needed

Create:

- League Admin
- Wager Admin
- Bronze
- Silver
- Gold
- Platinum
- Emerald
- Diamond
- Master
- Grandmaster
- Elite
- Legend

Move the bot role above every rank role so it can assign and remove them.

## Bot permissions

The bot needs:

- View Channels
- Send Messages
- Embed Links
- Attach Files
- Read Message History
- Manage Channels
- Manage Roles
- Manage Nicknames
- Manage Messages

Enable **Server Members Intent** in the Discord Developer Portal.

## Railway variables

Copy `.env.example` and fill in every value.

`CLIENT_ID` is the Discord application ID.

`GUILD_ID` is your Discord server ID.

Use Discord Developer Mode to copy all channel and role IDs.

## Persistent Railway database

Create a Railway Volume and mount it at:

```text
/data
```

Keep:

```env
DATABASE_PATH=/data/league.db
```

Without a Railway Volume, Railway may erase the database during a redeploy.

## Deployment

1. Upload every file from this ZIP directly into the root of a GitHub repository.
2. Deploy the repository through Railway.
3. Add every variable from `.env.example`.
4. Add and mount the Railway Volume.
5. Start the deployment.

The bot automatically registers its slash commands and creates or refreshes its panels.

## Admin commands

- `/league-setup`
- `/stats`
- `/leavequeue`
- `/setpoints`
- `/addpoints`
- `/removepoints`

Never upload your real Discord token to GitHub.
