```javascript
// database.js
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

async function initDb() {
    const db = await open({
        filename: './beer_bot.db',
        driver: sqlite3.Database
    });

    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            user_id TEXT PRIMARY KEY,
            name TEXT,
            beer_count INTEGER DEFAULT 0,
            violations INTEGER DEFAULT 0,
            is_banned INTEGER DEFAULT 0,
            streak_count INTEGER DEFAULT 0,
            last_post_date TEXT
        );

        CREATE TABLE IF NOT EXISTS system_stats (
            key TEXT PRIMARY KEY,
            value INTEGER DEFAULT 0
        );
    `);

    await db.run(`INSERT OR IGNORE INTO system_stats (key, value) VALUES ('total_beers', 0)`);
    await db.run(`INSERT OR IGNORE INTO system_stats (key, value) VALUES ('peak_window_beers', 0)`);

    return db;
}

module.exports = { initDb };
```
