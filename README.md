# clans-vs-society
# clans-vs-society

## Admin panel

Admins get an **Admin** link in the sidebar, which opens `/admin`.

**Making yourself an admin.** Set `ADMIN_EMAILS` in Railway to a comma-separated list of Google emails (for example `you@gmail.com`). Anyone on that list becomes an admin the next time they log in. You can also run this in the database:

```sql
UPDATE "User" SET "isAdmin" = true WHERE email = 'you@gmail.com';
```

Once you're an admin, you can grant or remove admin access for other players from their player page.

**What's in it**

- **Overview** – who's online now, daily/weekly activity, signups, class mix, gold in circulation, open feedback and recent errors.
- **Players** – search, filter and sort. Each player page shows stats, inventory, skills, activity, logins and admin history, with tools to edit stats, give/remove items, free from jail or the Infirmary, cancel travel, end a stuck fight, reset cooldowns, force logout, ban/unban and grant admin. It also lists other accounts seen on the same IP.
- **Login log** – every login, logout and kick with IP and device, filterable by player, IP, type and date. Session length is estimated from last activity when a player just closes the tab.
- **Economy** – gold over time (hourly snapshots, 14 days), biggest 24-hour gains, richest players, and anyone holding 5× the gold of their level.
- **Market** – all listings with price vs. base price; remove a listing and return the items to the seller.
- **Items / Houses** – edit items and create new ones; rename houses, edit mottos and vault gold, transfer leadership, disband.
- **Feedback** – feedback is now saved in the database as well as emailed, so you can read it and mark it resolved here.
- **Errors** – everything passed to `logError()` (kept 30 days).
- **Announcements** – a banner shown at the top of every game page, with an optional expiry.
- **Audit log** – every admin action, with before/after values.

Bans take effect immediately: the player is logged out, can't log back in until the ban ends, and sees a notice on the login page.
