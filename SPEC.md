# Uptime

Easy to use, open source status page, hostable on Cloudflare

## Goals
- Open source, people can fork and host their own status page
- Runs on cloudflare or wherever so you can have something dependendable away from where you host your app
- Creates a nice UI that can be shown to customers

## Tech stack
- Hono
- Sqlite compatible schema - D1 when hosted on cloudflare but can use both
- Use the turbo technologies brand guidelines (~/projects/turbotechnologies-brand)
- Wrangler

## How it works
- Status checks are defined by a config file - probably yaml as it allows comments. There should be a linter for this.
- Status checks for now are HTTP/HTTPS and then there is a definition (non 200 codes, 2 consecutive errors, or errors over 5 minutes etc)
- Cloudflare has a cron and then runs the status checks and then sees if any are in alarm
- If any have an incident, it should show this at the top of the page
- Supports pings to ntfy and a webhook - configurable for each or for global
- Should also have it's own endpoint that recieves pings and then if it doesn't get them on an expected schedule (with a configurable threshold), it should consider this an incident also.

## UI
- The static frontend should show a the name of each service, a set of lines of green, grey, red, or yellow and the % uptime over the past 90 days
- the key is grey = no data, green = all good, yellow = degraded, red = down
- each service/monitor has a card with the above info, tile them to look nice
