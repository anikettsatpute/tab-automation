# Discord auth

## Default (ships now): bot token + channel picker

1. `npm run setup` step 4/6 asks for the bot token.
2. Wizard calls `GET /users/@me` (identity), `GET /users/@me/guilds`,
   `GET /guilds/{id}/channels` and lets the installer pick ONE main channel
   + optional extras + owner user id.
3. Saved to `config/discord.json`; `DISCORD_CHANNEL_ID` + `DISCORD_OWNER_USER_ID`
   mirrored to `.env`. A send probe confirms the bot can post.
4. Works for any installer — no browser, no OAuth app needed.

## Optional Phase 2: OAuth2 browser login

Only if manual ID entry proves painful. Requires app Client ID/Secret,
`http://localhost:<port>/callback`, scopes
`identify guilds channels.read bot applications.commands`, refresh-token
persistence. Sending still needs the bot in the channel, so OAuth only
improves the picker — not message delivery. Deferred until requested.
