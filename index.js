require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const Groq = require('groq-sdk');
const express = require('express');
const qrcodeLib = require('qrcode');

// ==========================================
// 0. Web Server (For Render QR Code & Logs)
// ==========================================
const app = express();
const PORT = process.env.PORT || 3000;

// Capture logs so we can display them on the web page
const recentLogs = [];
const originalLog = console.log;
const originalError = console.error;

console.log = function(...args) {
    recentLogs.push('[' + new Date().toLocaleTimeString() + '] ' + args.join(' '));
    if (recentLogs.length > 50) recentLogs.shift();
    originalLog.apply(console, args);
};

console.error = function(...args) {
    recentLogs.push('[' + new Date().toLocaleTimeString() + '] ❌ ERROR: ' + args.join(' '));
    if (recentLogs.length > 50) recentLogs.shift();
    originalError.apply(console, args);
};

let latestQrImage = null;
let isClientReady = false;

app.get('/', (req, res) => {
    if (isClientReady) {
        res.send('<h1 style="font-family:sans-serif; text-align:center; margin-top:50px; color:green;">✅ WhatsApp is Connected! The bot is running perfectly.</h1>');
    } else if (latestQrImage) {
        res.send(`
            <html>
                <body style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; font-family:sans-serif; background-color:#f0f2f5;">
                    <h2>Scan this QR Code with WhatsApp</h2>
                    <img src="${latestQrImage}" alt="QR Code" style="width: 350px; height: 350px; border-radius: 10px; box-shadow: 0 4px 10px rgba(0,0,0,0.1); border: 15px solid white;"/>
                    <p style="color: #666; margin-top: 20px; font-size: 1.2rem;">QR code expires every 30 seconds. <b>Refresh this page</b> to get a fresh one if it fails.</p>
                </body>
            </html>
        `);
    } else {
        res.send('<h1 style="font-family:sans-serif; text-align:center; margin-top:50px;">⏳ Generating QR Code... Please wait and refresh in 10 seconds.</h1>');
    }
});

// Secret debugging page!
app.get('/logs', (req, res) => {
    res.send('<h2>Bot Logs:</h2><pre style="background:#222; color:#0f0; padding:20px; font-size:1.2rem; border-radius:10px;">' + recentLogs.join('<br>') + '</pre>');
});

app.listen(PORT, () => {
    console.log(`🌐 Web Server running on port ${PORT}`);
});

// Initialize Groq AI
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ==========================================
// 1. Google Sheets Configuration
// ==========================================
const serviceAccountAuth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : '',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);

async function appendToSheet(date, sender, messageContent, name, quantity, product) {
    try {
        await doc.loadInfo(); 
        const sheet = doc.sheetsByIndex[0];
        
        await sheet.addRow([
            date,
            sender,
            name || '',
            quantity || '',
            product || ''
        ]);
        console.log(`✅ Logged order from ${sender} to Google Sheets`);
    } catch (err) {
        console.error('❌ Error writing to Google Sheets.');
        console.error(err.message);
    }
}

// ==========================================
// 2. WhatsApp Client Configuration
// ==========================================
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--disable-gpu'
        ]
    }
});

client.on('qr', async (qr) => {
    console.log('📱 QR Code Generated! Go to your Render Web Service URL to see the image!');
    qrcode.generate(qr, { small: true }); // Fallback for terminal
    
    // Generate image for the website
    try {
        latestQrImage = await qrcodeLib.toDataURL(qr);
    } catch (err) {
        console.error('❌ Failed to generate QR image for web:', err);
    }
});

client.on('ready', () => {
    isClientReady = true;
    latestQrImage = null; // Clear image from memory
    console.log('✅ WhatsApp Client is ready and listening for messages!');
});

// ==========================================
// 3. Conversational Memory Storage
// ==========================================
const chatSessions = {};

client.on('message', async msg => {
    // Completely ignore any messages that arrive before the bot is fully logged in!
    // This perfectly prevents the bot from reading your chat history without relying on buggy server clocks.
    if (!isClientReady) return;

    const contact = await msg.getContact();
    const sender = contact.number; 
    const senderName = contact.pushname || contact.name || sender;
    const date = new Date(msg.timestamp * 1000).toLocaleString();
    const text = msg.body;

    console.log(`📨 Received message from ${senderName}: ${text}`);

    if (!text) return;

    if (!chatSessions[sender]) {
        chatSessions[sender] = [];
    }

    chatSessions[sender].push({ role: 'user', content: text });

    if (chatSessions[sender].length > 10) {
        chatSessions[sender] = chatSessions[sender].slice(-10);
    }

    try {
        console.log(`   -> Asking Groq AI to analyze the conversation...`);
        
        const systemPrompt = `
You are a helpful order-taking assistant on WhatsApp. Your goal is to collect 3 pieces of information:
1. Customer's Name
2. Product Name
3. Quantity

Follow these strict rules:
- Keep your replies short, friendly, and conversational.
- If you are missing any of the 3 required details, ask the user for them naturally.
- Output ONLY a valid JSON object. Do not include markdown formatting or extra text.

JSON FORMAT WHEN ASKING FOR MISSING DETAILS:
{"status": "asking", "reply": "Your conversational reply here"}

JSON FORMAT WHEN ALL 3 DETAILS ARE COLLECTED:
{"status": "complete", "name": "extracted_name", "quantity": "extracted_quantity", "product": "extracted_product", "reply": "Awesome, your order is confirmed!"}
`;

        const messages = [
            { role: 'system', content: systemPrompt },
            ...chatSessions[sender]
        ];

        const chatCompletion = await groq.chat.completions.create({
            messages: messages,
            model: 'llama-3.1-8b-instant',
            temperature: 0.2,
            response_format: { type: "json_object" } 
        });

        const responseText = chatCompletion.choices[0]?.message?.content || '{}';
        const data = JSON.parse(responseText);

        console.log(`   -> Groq Status: ${data.status}`);

        if (data.status === 'asking') {
            await msg.reply(data.reply);
            chatSessions[sender].push({ role: 'assistant', content: data.reply });
            console.log(`   -> Sent follow-up question to ${senderName}`);

        } else if (data.status === 'complete') {
            await appendToSheet(date, senderName, text, data.name, data.quantity, data.product);
            await msg.reply(`✅ ${data.reply}`);
            console.log(`   -> Sent confirmation and cleared memory for ${senderName}`);
            delete chatSessions[sender];
        }

    } catch (err) {
        console.error('   -> Groq AI Error:', err.message);
        
        if (text.includes(',')) {
            const parts = text.split(',');
            if (parts.length >= 2) {
                const fallbackName = parts[0].trim();
                const rest = parts.slice(1).join(',').trim(); 
                const match = rest.match(/^(\d+)\s*(.+)$/);
                if (match) {
                    await appendToSheet(date, senderName, text, fallbackName, match[1], match[2].trim());
                    await msg.reply(`✅ Order automatically recorded via fallback system.`);
                }
            }
        }
    }
});

client.initialize();
