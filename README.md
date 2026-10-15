# clans-vs-society
# clans-vs-society

## Admin panel

Staff get an **Admin** link in the sidebar, which opens `/admin`.

### Roles

Every account has a role: `player` (default), `moderator` or `admin`.

- **Moderators** can look at everything except server errors, and can moderate: free players from jail or hospital, fix stuck travel and fights, reset cooldowns, force logout, ban and unban players, remove market listings, rename houses, handle feedback and post announcements.
- **Admins** can also change the game itself: edit player stats, give and remove items, edit items, change house gold, transfer or disband houses, see and clear server errors, and change roles.
- Moderators can't kick or ban other staff. Nobody can change their own role, and the last admin can't be demoted.

The full permission list is at the top of `admin.js`.

**Making yourself an admin.** Set `ADMIN_EMAILS` in Railway (and in your local `.env`) to a comma-separated list of Google emails. Anyone on that list is always an admin, even if their role in the database says otherwise, so you can't lock yourself out. Give other people roles from their player page in the admin panel.

### What's in it

- **Overview** – who's online now, daily/weekly activity, signups, class mix, gold in circulation, open feedback, recent errors.
- **Players** – search, filter and sort. Each player page shows stats, inventory, activity, logins, game events and staff actions, plus the tools above. It also lists other accounts seen on the same IP.
- **Login Log** – every login, logout, kick and ban, with IP and device. Session length is estimated from last activity when a player just closes the tab.
- **Economy** – gold over time (hourly snapshots, 14 days), biggest 24-hour gains, richest players, and anyone holding 5× the gold of their level.
- **Market, Items, Houses** – moderate listings, edit items, manage houses.
- **Feedback** – feedback is saved in the database as well as emailed.
- **Errors** – everything passed to `logError()` (kept 30 days).
- **Announcements** – a banner at the top of every game page, with an optional expiry.
- **Activity** – the activity messages players see, across all players.
- **Audit Log** – everything in `AuditLog`: logins (`auth.*`), staff actions (`admin.*`, with before/after values) and game events (`market.*`, `raid.*`, `house.*`, …). Kept 90 days.

Bans take effect immediately: the player is logged out, can't log back in until the ban ends, and sees a notice on the login page.

### Migrations

The migration history starts from `prisma/migrations/0_init` (the old migrations are kept in `prisma/migrations_old` for reference). `npm run build` runs `scripts/baseline-migrations.js` before `prisma migrate deploy`: on a database that already has the game's tables, it marks `0_init` (and any later migration whose changes are already there) as applied, so deploys don't try to recreate existing tables. A brand-new database is built from scratch.
