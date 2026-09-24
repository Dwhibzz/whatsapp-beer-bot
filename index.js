const http = require('http');
const fs = require('fs');

// Railway passes PORT dynamically; default to 8080 if not set
const PORT = process.env.PORT || 8080;

// 1. Instantly respond to ALL Railway health probes to prevent "Stopping Container" restarts
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`HTTP Health Check server running on port ${PORT}`);
    initWhatsAppClient();
});

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');
const { GoogleGenAI } = require('@google/genai');
const { initDb } = require('./database');

// --- CONFIGURATION ---
const TARGET_GROUP_NAME = "Beers Only"; // Target WhatsApp group name

// Gemini API Initialization
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const ai = new GoogleGenAI({ apiKey: GEMINI_KEY });

let db;

// Prevent Node crashes from unhandled errors
process.on('uncaughtException', (err) => {
    console.error('Caught unhandled exception (preventing crash):', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// --- AI VISION VERIFICATION ---
async function verifyBeerImage(base64Data, mimeType) {
    try {
        if (!process.env.GEMINI_API_KEY) {
            console.error('⚠️ GEMINI_API_KEY environment variable is missing!');
            return 'BEER'; // Fail safe if key is not provided
        }

        console.log('🤖 Sending image to Gemini API...');

        const cleanMimeType = mimeType ? mimeType.split(';')[0] : 'image/jpeg';

        const prompt = `Analyze this image strictly for a beer group chat.
        
        Check the following:
        1. Is it a valid BEER (pint, beer bottle, beer can, craft ale, stout, lager, cider, pub tap, brewery flight)?
        2. Is it a NON-ALCOHOLIC OR NON-BEER DRINK (water bottle, coffee cup, tea mug, soda can, juice box, energy drink, milk glass, wine, cocktail)?
        
        Reply strictly with ONE of these words:
        - 'BEER' if it is a valid beer or cider.
        - 'NON_ALCOHOLIC_DRINK' if it is a soft drink, water, coffee, tea, juice, or non-beer beverage.
        - 'INVALID' if it is a pet, meme, selfie with no drink, food plate, empty glass, or random object.`;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [
                {
                    role: 'user',
                    parts: [
                        {
                            inlineData: {
                                mimeType: cleanMimeType,
                                data: base64Data
                            }
                        },
                        {
                            text: prompt
                        }
                    ]
                }
            ]
        });

        const text = response.text ? response.text.trim().toUpperCase() : '';
        console.log(`🤖 [GEMINI VISION RESULT]: "${text}"`);

        if (text.includes('NON_ALCOHOLIC_DRINK')) return 'NON_ALCOHOLIC_DRINK';
        if (text.includes('BEER')) return 'BEER';
        return 'INVALID';

    } catch (err) {
        console.error('❌ Gemini API Exception:', err);
        return 'BEER'; // Fail-safe to BEER so API hiccups don't kick users
    }
}

// --- UK PEAK HOURS CHECKER (Thursday 5 PM to Sunday 8 PM UK Time) ---
function isPeakWindow() {
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/London" }));
    const day = now.getDay();
    const hour = now.getHours();

    if (day === 4 && hour >= 17) return true;
    if (day === 5) return true;
    if (day === 6) return true;
    if (day === 0 && hour < 20) return true;
    
    return false;
}

// --- DAYS UNTIL NEXT QUARTERLY PROFILE PHOTO DATE ---
function getDaysUntilNextQuarter() {
    const now = new Date();
    const year = now.getFullYear();
    
    const quarterMonths = [0, 3, 6, 9];
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

// --- HELPER TO BUILD SUNDAY REPORT ---
async function generateSundayReport() {
    const pardonedUsers = [];
    const yellowCardUsers = await db.all(`SELECT * FROM users WHERE violations = 1 AND streak_count >= 7 AND is_banned = 0`);
    for (const u of yellowCardUsers) {
        await db.run(`UPDATE users SET violations = 0 WHERE user_id = ?`, [u.user_id]);
        pardonedUsers.push(u.user_id);
    }

    const totalRow = await db.get(`SELECT value FROM system_stats WHERE key = 'total_beers'`);
    const peakRow = await db.get(`SELECT value FROM system_stats WHERE key = 'peak_window_beers'`);
    
    const topPosters = await db.all(`SELECT * FROM users WHERE is_banned = 0 ORDER BY beer_count DESC LIMIT 5`);
    const shamedUsers = await db.all(`SELECT * FROM users WHERE violations > 0 ORDER BY is_banned DESC, violations DESC`);
    const daysLeft = getDaysUntilNextQuarter();

    let report = `🍺 *POST-MATCH ANALYSIS* 🍺\n\n`;
    report += `📊 *Total Beers Uploaded:* ${totalRow ? totalRow.value : 0}\n`;
    report += `🔥 *Weekend Bender (Thu-Sun):* ${peakRow ? peakRow.value : 0}\n\n`;
    report += `🏆 *THE STARTING XI (TOP 5):*\n`;

    const mentions = [];
    topPosters.forEach((user, idx) => {
        const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : '🍻';
        const streak = user.streak_count > 1 ? ` 🔥 ${user.streak_count}d` : '';
        report += `${medal} ${idx + 1}. @${user.user_id.split('@')[0]} — ${user.beer_count} beers${streak}\n`;
        mentions.push(user.user_id);
    });

    if (pardonedUsers.length > 0) {
        report += `\n🧼 *VAR PARDONS (7-Day Good Behavior):*\n`;
        pardonedUsers.forEach(id => {
            report += `🟢 Yellow Card rescinded for @${id.split('@')[0]}\n`;
            mentions.push(id);
        });
    }

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

    return { report, mentions };
}

// --- CARD & KICK HANDLER ---
async function handleViolation(msg, senderId, violationType = 'STANDARD', isGroupAdmin = false) {
    if (isGroupAdmin) {
        console.log(`🛡️ Admin ${senderId.split('@')[0]} posted non-beer content (${violationType}), but admins are immune to VAR penalties.`);
        return;
    }

    let chat;
    try {
        chat = await msg.getChat();
    } catch (e) {
        console.error('Warning: could not fetch chat object for violation handling:', e.message);
    }

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

        if (chat) {
            try {
                await chat.removeParticipants([senderId]);
                console.log(`Straight Red: Kicked @${senderId.split('@')[0]} for soft drink post.`);
            } catch (kickErr) {
                console.error(`Failed to kick @${senderId.split('@')[0]}. Ensure bot is Admin:`, kickErr);
            }
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

        if (chat) {
            try {
                await chat.removeParticipants([senderId]);
                console.log(`Kicked @${senderId.split('@')[0]} from group.`);
            } catch (kickErr) {
                console.error(`Failed to kick @${senderId.split('@')[0]}. Ensure bot is Admin:`, kickErr);
            }
        }
    }
}

// --- CHECK & AWARD ACHIEVEMENTS ---
async function checkAchievements(msg, senderId, newTotalBeers, newStreak) {
    let badgeTitle = '';
    let badgeDesc = '';

    if (newTotalBeers === 100) {
        badgeTitle = '💯 The Centurion';
        badgeDesc = '100 total beers logged!';
    } else if (newStreak === 7) {
        badgeTitle = '🏃 The Marathon Runner';
        badgeDesc = '7-day consecutive beer streak logged!';
    }

    if (badgeTitle) {
        await msg.reply(
            `🏆 *ACHIEVEMENT UNLOCKED!* 🏆\n\n` +
            `@${senderId.split('@')[0]} just earned: *${badgeTitle}*\n` +
            `_${badgeDesc}_\n\n` +
            `Total Beers: ${newTotalBeers} | Streak: ${newStreak}d 🍻`,
            null,
            { mentions: [senderId] }
        );
    }
}

// --- INITIALIZE WHATSAPP CLIENT ---
function initWhatsAppClient() {
    const client = new Client({
        authStrategy: new LocalAuth({ dataPath: '/app/.wwebjs_auth_v3' }),
        puppeteer: {
            headless: true,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu'
            ]
        }
    });

    client.on('qr', (qr) => {
        console.log('Scan this QR code using your secondary WhatsApp number:');
        qrcode.generate(qr, { small: true });
    });

    client.on('disconnected', (reason) => {
        console.error('❌ WhatsApp Web disconnected! Reason:', reason);
        process.exit(1);
    });

    client.on('ready', async () => {
        console.log('🍺 Beer Bot is online!');
        db = await initDb();

        setTimeout(async () => {
            try {
                const chats = await client.getChats();
                const targetGroup = chats.find(c => c.isGroup && c.name.toLowerCase().trim() === TARGET_GROUP_NAME.toLowerCase().trim());

                if (targetGroup) {
                    console.log(`✅ CONNECTED: Target group "${targetGroup.name}" is active.`);
                } else {
                    console.log(`ℹ️ Startup sync complete. Standing by for incoming messages in "${TARGET_GROUP_NAME}".`);
                }
            } catch (err) {
                console.log(`ℹ️ Startup sync complete. Listener active for "${TARGET_GROUP_NAME}".`);
            }
        }, 10000);

        cron.schedule('0 0 * * *', async () => {
            try {
                const backupPath = '/app/.wwebjs_auth/beerbot_backup.db';
                if (fs.existsSync(backupPath)) {
                    fs.unlinkSync(backupPath);
                }
                await db.run(`VACUUM INTO '${backupPath}'`);
                console.log('📦 Daily database backup refreshed successfully in persistent volume.');
            } catch (err) {
                console.error('Failed to create daily database backup:', err);
            }
        }, {
            scheduled: true,
            timezone: "Europe/London"
        });

        setInterval(async () => {
            try {
                if (client && client.pupPage) {
                    await client.pupPage.evaluate(() => window.WWebJS?.sendPresenceAvailable?.());
                }
            } catch (e) {}
        }, 5 * 60 * 1000);

        setInterval(async () => {
            if (client.pupPage) {
                try {
                    const devTools = await client.pupPage.target().createCDPSession();
                    await devTools.send('Network.clearBrowserCache');
                    await devTools.detach();
                } catch (e) {}
            }
            if (global.gc) global.gc();
        }, 15 * 60 * 1000);

        cron.schedule('0 20 * * 0', async () => {
            try {
                const chats = await client.getChats();
                const targetChat = chats.find(c => c.isGroup && c.name.toLowerCase().trim() === TARGET_GROUP_NAME.toLowerCase().trim());
                if (!targetChat) return;

                const { report, mentions } = await generateSundayReport();

                await targetChat.sendMessage(report, { mentions });
                await db.run(`UPDATE system_stats SET value = 0 WHERE key = 'peak_window_beers'`);
                console.log('Sunday 8 PM UK report posted successfully.');
            } catch (err) {
                console.error('Error executing Sunday cron job:', err);
            }
        }, {
            scheduled: true,
            timezone: "Europe/London"
        });

        cron.schedule('0 9 1 1,4,7,10 *', async () => {
            try {
                const chats = await client.getChats();
                const targetChat = chats.find(c => c.isGroup && c.name.toLowerCase().trim() === TARGET_GROUP_NAME.toLowerCase().trim());
                if (!targetChat) return;

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
        try {
            if (!msg.from.endsWith('@g.us')) return;

            let chat;
            try {
                chat = await msg.getChat();
            } catch (chatErr) {
                console.error('⚠️ Could not fetch chat object:', chatErr.message);
            }

            if (chat && chat.name.toLowerCase().trim() !== TARGET_GROUP_NAME.toLowerCase().trim()) {
                return;
            }

            const senderId = msg.author || msg.from;
            const senderNumber = senderId.split('@')[0];

            if (msg.body === '!status' || msg.body === '!ping') {
                const isGroupAdmin = chat && chat.participants ? chat.participants.some(
                    p => p.id._serialized === senderId && (p.isAdmin || p.isSuperAdmin)
                ) : false;

                if (!isGroupAdmin) return;

                const user = await db.get(`SELECT * FROM users WHERE user_id = ?`, [senderId]);
                const beerCount = user ? user.beer_count : 0;
                const streak = user ? user.streak_count : 0;

                await msg.reply(
                    `🤖 *BOT STATUS: ONLINE* 🟢\n\n` +
                    `• Database: Connected\n` +
                    `• Group: ${chat ? chat.name : TARGET_GROUP_NAME}\n` +
                    `• Your Logged Beers: ${beerCount}\n` +
                    `• Your Current Streak: ${streak}d\n\n` +
                    `All systems operational! 🍻`
                );
                return;
            }

            if (msg.body === '!report' || msg.body === '!summary') {
                const isGroupAdmin = chat && chat.participants ? chat.participants.some(
                    p => p.id._serialized === senderId && (p.isAdmin || p.isSuperAdmin)
                ) : false;

                if (!isGroupAdmin) return;

                const { report, mentions } = await generateSundayReport();
                if (chat) {
                    await chat.sendMessage(report, { mentions });
                } else {
                    await msg.reply(report, null, { mentions });
                }
                await db.run(`UPDATE system_stats SET value = 0 WHERE key = 'peak_window_beers'`);
                console.log('Manual report command executed.');
                return;
            }

            // Accept ALL media uploads regardless of sub-type string
            if (!msg.hasMedia) return;

            console.log(`📸 Image received in ${chat ? chat.name : TARGET_GROUP_NAME} from @${senderNumber}.`);

            const isGroupAdmin = chat && chat.participants ? chat.participants.some(
                p => p.id._serialized === senderId && (p.isAdmin || p.isSuperAdmin)
            ) : false;

            const userName = msg._data?.notifyName || senderNumber;
            let user = await db.get(`SELECT * FROM users WHERE user_id = ?`, [senderId]);
            if (!user) {
                await db.run(`INSERT INTO users (user_id, name) VALUES (?, ?)`, [senderId, userName]);
                user = await db.get(`SELECT * FROM users WHERE user_id = ?`, [senderId]);
            }

            let media;
            try {
                console.log('⏳ Downloading media buffer...');
                media = await msg.downloadMedia();
                if (!media || !media.data) {
                    console.error('❌ Downloaded media buffer was empty.');
                    return;
                }
                console.log(`✅ Media downloaded (${media.data.length} bytes). Sending to Gemini...`);
            } catch (downloadErr) {
                console.error(`❌ Failed to download media buffer from @${senderNumber}:`, downloadErr.message);
                return;
            }

            const imageCheckResult = await verifyBeerImage(media.data, media.mimetype);
            console.log(`🔍 Verdict for @${senderNumber}: ${imageCheckResult}`);

            media = null;
            if (global.gc) global.gc();

            if (imageCheckResult === 'NON_ALCOHOLIC_DRINK') {
                console.log(`🚨 SOFT DRINK DETECTED from @${senderNumber}! Triggering VAR Red Card...`);
                await handleViolation(msg, senderId, 'NON_ALCOHOLIC_DRINK', isGroupAdmin);
                return;
            }

            if (imageCheckResult === 'INVALID') {
                console.log(`🟨 INVALID IMAGE DETECTED from @${senderNumber}! Triggering VAR Yellow Card...`);
                await handleViolation(msg, senderId, 'STANDARD', isGroupAdmin);
                return;
            }

            const nowUK = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/London" }));
            const todayStr = nowUK.toLocaleDateString("en-CA");

            const yesterdayUK = new Date(nowUK);
            yesterdayUK.setDate(yesterdayUK.getDate() - 1);
            const yesterdayStr = yesterdayUK.toLocaleDateString("en-CA");

            let newStreak = 1;
            if (user.last_post_date === yesterdayStr) {
                newStreak = user.streak_count + 1;
            } else if (user.last_post_date === todayStr) {
                newStreak = user.streak_count;
            }

            const newTotalBeers = user.beer_count + 1;

            try {
                await db.run(
                    `UPDATE users SET beer_count = ?, streak_count = ?, last_post_date = ? WHERE user_id = ?`,
                    [newTotalBeers, newStreak, todayStr, senderId]
                );

                await db.run(`UPDATE system_stats SET value = value + 1 WHERE key = 'total_beers'`);

                if (isPeakWindow()) {
                    await db.run(`UPDATE system_stats SET value = value + 1 WHERE key = 'peak_window_beers'`);
                }
            } catch (dbErr) {
                console.error('❌ Database update error:', dbErr);
            }

            try {
                await msg.react('🍺');
                console.log(`✅ Successfully reacted with 🍺 to @${senderNumber}`);
            } catch (reactErr) {
                console.error(`⚠️ Could not place emoji reaction for @${senderNumber}:`, reactErr.message);
            }

            console.log(`✅ SUCCESS: Verified beer from ${userName} (@${senderNumber}) | Total: ${newTotalBeers} | Streak: ${newStreak}d`);

            await checkAchievements(msg, senderId, newTotalBeers, newStreak);

        } catch (err) {
            console.error('Unhandled exception in message processing pipeline:', err);
            if (global.gc) global.gc();
        }
    });

    client.initialize();
}
