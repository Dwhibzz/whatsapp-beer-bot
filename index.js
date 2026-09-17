// index.js
const http = require('http');
// Keeps Render Web Service awake by binding to an HTTP port
http.createServer((req, res) => res.end('Beer Bot is awake!')).listen(process.env.PORT || 3000);

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');
const { GoogleGenAI } = require('@google/genai');
const { initDb } = require('./database');

// --- CONFIGURATION ---
const TARGET_GROUP_NAME = "Beers Only"; // Match your exact WhatsApp group name
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

let beerGroupId = null;
let db;

// --- AI VISION VERIFICATION WITH DETAILED RULES ---
async function verifyBeerImage(mediaBuffer, mimeType) {
    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [
                {
                    inlineData: {
                        data: mediaBuffer.toString('base64'),
                        mimeType: mimeType
                    }
                },
                `Analyze this image strictly for a beer group chat.
                
                Check the following:
                1. Is it a valid BEER (pint, beer bottle, beer can, craft ale, stout, lager, cider, pub tap, brewery flight)?
                2. Is it a NON-ALCOHOLIC OR NON-BEER DRINK (water bottle, coffee cup, tea mug, soda can, juice box, energy drink, milk glass, wine, cocktail)?
                
                Reply strictly with one of these three words:
                - 'BEER' if it is a valid beer/cider.
                - 'NON_ALCOHOLIC_DRINK' if it is explicitly a soft drink, water, coffee, tea, juice, or non-beer beverage.
                - 'INVALID' if it is a pet, meme, selfie with no drink, food plate, empty glass, or random object.`
            ]
        });
        const text = response.text.trim().toUpperCase();
        if (text.includes('NON_ALCOHOLIC_DRINK')) return 'NON_ALCOHOLIC_DRINK';
        if (text.includes('BEER')) return 'BEER';
        return 'INVALID';
    } catch (err) {
        console.error('AI Verification error (failing safe):', err);
        return 'BEER'; // Fallback to prevent breaking on API timeouts
    }
}

// --- UK PEAK HOURS CHECKER (Thursday 5 PM to Sunday 8 PM UK Time) ---
function isPeakWindow() {
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/London" }));
    const day = now.getDay(); // 0 = Sun, 4 = Thu, 5 = Fri, 6 = Sat
    const hour = now.getHours();

    if (day === 4 && hour >= 17) return true;  // Thursday 5:00 PM - 11:59 PM
    if (day === 5) return true;                 // Friday all day
    if (day === 6) return true;                 // Saturday all day
    if (day === 0 && hour < 20) return true;    // Sunday 12:00 AM - 7:59 PM (Closes at 8 PM)
    
    return false;
}

// --- DAYS UNTIL NEXT QUARTERLY PROFILE PHOTO DATE ---
function getDaysUntilNextQuarter() {
    const now = new Date();
    const year = now.getFullYear();
    
    const quarterMonths = [0, 3, 6, 9]; // Jan 1, Apr 1, Jul 1, Oct 1
    let nextQuarterDate = null;

    for (const month of quarterMonths) {
        const candidate = new Date(year, month, 1);
        if (candidate > now) {
            nextQuarterDate = candidate;
            break;
        }
    }

    if (!nextQuarterDate) {
        nextQuarterDate = new Date(year + 1, 0, 1);
    }

    const diffTime = Math.abs(nextQuarterDate - now);
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

// --- CARD & KICK HANDLER (iPhone Formatting Optimized) ---
async function handleViolation(chat, msg, senderId, violationType = 'STANDARD') {
    if (violationType === 'NON_ALCOHOLIC_DRINK') {
        await db.run(`UPDATE users SET violations = 2, is_banned = 1 WHERE user_id = ?`, [senderId]);

        await msg.reply(
            `🟥🟥🟥🟥🟥🟥🟥🟥\n` +
            `*VAR: STRAIGHT RED* 🟥\n` +
            `🟥🟥🟥🟥🟥🟥🟥🟥\n\n` +
            `@${senderId.split('@')[0]} posted a soft drink!\n\n` +
            `*INSTANT RED CARD & KICKED!* 🚪💥`,
            null,
            { mentions: [senderId] }
        );

        try {
            await chat.removeParticipants([senderId]);
            console.log(`Straight Red: Kicked @${senderId.split('@')[0]} for soft drink post.`);
        } catch (kickErr) {
            console.error(`Failed to kick @${senderId.split('@')[0]}. Ensure bot is Admin:`, kickErr);
        }
        return;
    }

    await db.run(`UPDATE users SET violations = violations + 1 WHERE user_id = ?`, [senderId]);
    const updatedUser = await db.get(`SELECT violations FROM users WHERE user_id = ?`, [senderId]);

    if (updatedUser.violations === 1) {
        await msg.reply(
            `🟨🟨🟨🟨🟨🟨🟨🟨\n` +
            `*VAR: YELLOW CARD* 🟨\n` +
            `🟨🟨🟨🟨🟨🟨🟨🟨\n\n` +
            `@${senderId.split('@')[0]}, non-beer post detected!\n\n` +
            `You are on *1 Yellow Card*. Next violation = Red Card & Kick!`,
            null,
            { mentions: [senderId] }
        );
    } else if (updatedUser.violations >= 2) {
        await db.run(`UPDATE users SET is_banned = 1 WHERE user_id = ?`, [senderId]);

        await msg.reply(
            `🟥🟥🟥🟥🟥🟥🟥🟥\n` +
            `*VAR: RED CARD* 🟥\n` +
            `🟥🟥🟥🟥🟥🟥🟥🟥\n\n` +
            `@${senderId.split('@')[0]} has broken the rules twice!\n\n` +
            `*RED CARDED & KICKED!* 🚪💥`,
            null,
            { mentions: [senderId] }
        );

        try {
            await chat.removeParticipants([senderId]);
            console.log(`Kicked @${senderId.split('@')[0]} from group.`);
        } catch (kickErr) {
            console.error(`Failed to kick @${senderId.split('@')[0]}. Ensure bot is Admin:`, kickErr);
        }
    }
}

// --- INITIALIZE WHATSAPP CLIENT ---
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
        ]
    }
});

client.on('qr', (qr) => {
    console.log('Scan this QR code using your secondary WhatsApp number:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
    console.log('🍺 Beer Bot is online!');
    db = await initDb();

    const chats = await client.getChats();
    const group = chats.find(c => c.isGroup && c.name === TARGET_GROUP_NAME);

    if (group) {
        beerGroupId = group.id._serialized;
        console.log(`Connected to group: "${TARGET_GROUP_NAME}" (${beerGroupId})`);
    } else {
        console.error(`Group "${TARGET_GROUP_NAME}" not found. Ensure the bot is added!`);
    }

    // --- CRON 1: WEEKLY SUNDAY 8:00 PM UK REPORT ---
    cron.schedule('0 20 * * 0', async () => {
        if (!beerGroupId) return;

        try {
            const targetChat = await client.getChatById(beerGroupId);
            const totalRow = await db.get(`SELECT value FROM system_stats WHERE key = 'total_beers'`);
            const peakRow = await db.get(`SELECT value FROM system_stats WHERE key = 'peak_window_beers'`);
            
            const topPosters = await db.all(`SELECT * FROM users WHERE is_banned = 0 ORDER BY beer_count DESC LIMIT 5`);
            const shamedUsers = await db.all(`SELECT * FROM users WHERE violations > 0 ORDER BY is_banned DESC, violations DESC`);
            const daysLeft = getDaysUntilNextQuarter();

            let report = `🍺 *POST-MATCH ANALYSIS* 🍺\n\n`;
            report += `📊 *Total Beers Uploaded:* ${totalRow ? totalRow.value : 0}\n`;
            report += `🔥 *Weekend Bender (Thu-Sun):* ${peakRow ? peakRow.value : 0}\n\n`;
            report += `🏆 *THE STARTING XI:*\n`;

            const mentions = [];
            topPosters.forEach((user, idx) => {
                const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : '🍻';
                const streak = user.streak_count > 1 ? ` 🔥 ${user.streak_count}d` : '';
                report += `${medal} ${idx + 1}. @${user.user_id.split('@')[0]} — ${user.beer_count}${streak}\n`;
                mentions.push(user.user_id);
            });

            if (shamedUsers.length > 0) {
                report += `\n🚨 *VAR REVIEW:*\n`;
                shamedUsers.forEach(u => {
                    const status = u.is_banned ? '🟥 KICKED' : '🟨 YELLOW';
                    report += `${status} — @${u.user_id.split('@')[0]}\n`;
                    mentions.push(u.user_id);
                });
            }

            report += `\n🗓️ *${daysLeft} days* until Profile Photo Vote!\n\n`;
            report += `Cheers and Happy Drinking! 🍻`;

            await targetChat.sendMessage(report, { mentions });
            await db.run(`UPDATE system_stats SET value = 0 WHERE key = 'peak_window_beers'`);
            console.log('Sunday 8 PM UK report posted.');
        } catch (err) {
            console.error('Error executing Sunday cron job:', err);
        }
    }, {
        scheduled: true,
        timezone: "Europe/London"
    });

    // --- CRON 2: QUARTERLY PROFILE PHOTO VOTE ANNOUNCEMENT (Jan 1, Apr 1, Jul 1, Oct 1 at 9:00 AM UK) ---
    cron.schedule('0 9 1 1,4,7,10 *', async () => {
        if (!beerGroupId) return;

        try {
            const targetChat = await client.getChatById(beerGroupId);
            const admins = targetChat.participants.filter(p => p.isAdmin || p.isSuperAdmin);
            const adminMentions = admins.map(a => a.id._serialized);

            let pollAlert = `🗳️ *PROFILE PHOTO VOTE IS LIVE!* 🗳️\n\n`;
            pollAlert += `It is officially time to vote for the new group profile photo!\n\n`;
            pollAlert += `Admins pinged: `;
            
            adminMentions.forEach(id => {
                pollAlert += `@${id.split('@')[0]} `;
            });
            
            pollAlert += `\n\nPlease wait for the poll to be posted by the admins! 🍻`;

            await targetChat.sendMessage(pollAlert, { mentions: adminMentions });
            console.log('Quarterly poll vote announcement posted and admins tagged.');
        } catch (err) {
            console.error('Error executing Quarterly Poll cron job:', err);
        }
    }, {
        scheduled: true,
        timezone: "Europe/London"
    });
});

// --- MESSAGE PROCESSING & RULE ENFORCEMENT ---
client.on('message', async (msg) => {
    const chat = await msg.getChat();
    if (!chat.isGroup || chat.id._serialized !== beerGroupId) return;

    const senderId = msg.author || msg.from;

    const participant = chat.participants.find(p => p.id._serialized === senderId);
    const isAdmin = participant && (participant.isAdmin || participant.isSuperAdmin);

    if (isAdmin && !msg.body.startsWith('!')) {
        return;
    }

    if (msg.body.startsWith('!revert') || msg.body.startsWith('!var')) {
        const mentionedContacts = await msg.getMentions();
        if (mentionedContacts.length === 0) {
            await msg.reply('⚠️ Please mention the user to revert! Example: `!revert @user`');
            return;
        }

        const targetId = mentionedContacts[0].id._serialized;
        const user = await db.get(`SELECT * FROM users WHERE user_id = ?`, [targetId]);

        if (!user || user.violations === 0) {
            await msg.reply(`@${targetId.split('@')[0]} has a clean record! No penalties to revert.`, null, { mentions: [targetId] });
            return;
        }

        const newViolations = Math.max(0, user.violations - 1);
        const newBanStatus = newViolations >= 2 ? 1 : 0;

        await db.run(
            `UPDATE users SET violations = ?, is_banned = ? WHERE user_id = ?`,
            [newViolations, newBanStatus, targetId]
        );

        const statusText = newViolations === 0 
            ? '🟢 Clean Record (0 Cards)' 
            : '🟨 Downgraded to 1 Yellow Card';

        await msg.reply(
            `📺 *VAR: DECISION RESCINDED*\n\n` +
            `The card issued to @${targetId.split('@')[0]} has been *CANCELLED*!\n\n` +
            `Status: ${statusText}\n\n` +
            `Cheers! 🍻`,
            null,
            { mentions: [targetId] }
        );
        return;
    }

    if (msg.body.startsWith('!red') || msg.body.startsWith('!straightred')) {
        const mentionedContacts = await msg.getMentions();
        if (mentionedContacts.length === 0) {
            await msg.reply('⚠️ Please mention the user to red card! Example: `!red @user`');
            return;
        }

        const targetId = mentionedContacts[0].id._serialized;
        await db.run(`UPDATE users SET violations = 2, is_banned = 1 WHERE user_id = ?`, [targetId]);

        await msg.reply(
            `🟥🟥🟥🟥🟥🟥🟥🟥\n` +
            `*VAR: STRAIGHT RED* 🟥\n` +
            `🟥🟥🟥🟥🟥🟥🟥🟥\n\n` +
            `@${targetId.split('@')[0]} has been issued a *STRAIGHT RED CARD* by the admin!\n\n` +
            `*KICKED FROM THE GROUP!* 🚪💥`,
            null,
            { mentions: [targetId] }
        );

        try {
            await chat.removeParticipants([targetId]);
        } catch (kickErr) {
            console.error(`Failed to kick @${targetId.split('@')[0]}:`, kickErr);
        }
        return;
    }

    const contact = await msg.getContact();
    const userName = contact.pushname || contact.name || 'Unknown User';

    let user = await db.get(`SELECT * FROM users WHERE user_id = ?`, [senderId]);
    if (!user) {
        await db.run(`INSERT INTO users (user_id, name) VALUES (?, ?)`, [senderId, userName]);
        user = await db.get(`SELECT * FROM users WHERE user_id = ?`, [senderId]);
    }

    if (!msg.hasMedia || msg.type !== 'image') {
        await handleViolation(chat, msg, senderId, 'STANDARD');
        return;
    }

    const media = await msg.downloadMedia();
    if (!media) return;

    const imageBuffer = Buffer.from(media.data, 'base64');
    const imageCheckResult = await verifyBeerImage(imageBuffer, media.mimetype);

    if (imageCheckResult === 'NON_ALCOHOLIC_DRINK') {
        await handleViolation(chat, msg, senderId, 'NON_ALCOHOLIC_DRINK');
        return;
    }

    if (imageCheckResult === 'INVALID') {
        await handleViolation(chat, msg, senderId, 'STANDARD');
        return;
    }

    const todayStr = new Date().toISOString().split('T')[0];
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    let newStreak = 1;
    if (user.last_post_date === yesterdayStr) {
        newStreak = user.streak_count + 1;
    } else if (user.last_post_date === todayStr) {
        newStreak = user.streak_count;
    }

    await db.run(
        `UPDATE users SET beer_count = beer_count + 1, streak_count = ?, last_post_date = ? WHERE user_id = ?`,
        [newStreak, todayStr, senderId]
    );

    await db.run(`UPDATE system_stats SET value = value + 1 WHERE key = 'total_beers'`);

    if (isPeakWindow()) {
        await db.run(`UPDATE system_stats SET value = value + 1 WHERE key = 'peak_window_beers'`);
    }

    console.log(`Verified beer post from ${userName} (Streak: ${newStreak}d)`);
});

client.initialize();
