require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const Groq = require('groq-sdk');

const app = express();
app.use(bodyParser.json());

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

const PORT = process.env.PORT || 3000;

// Environment Variables
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "aurel_globe_secret_123";
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;

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
        console.error('❌ Error writing to Google Sheets:', err.message);
    }
}

// ==========================================
// 2. Meta WhatsApp API Helper
// ==========================================
async function sendWhatsAppMessage(recipientPhone, textMessage) {
    if (!META_ACCESS_TOKEN || !META_PHONE_NUMBER_ID) {
        console.error("❌ Missing Meta API Tokens in Environment Variables!");
        return;
    }

    const url = `https://graph.facebook.com/v19.0/${META_PHONE_NUMBER_ID}/messages`;
    
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${META_ACCESS_TOKEN}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                messaging_product: "whatsapp",
                to: recipientPhone,
                type: "text",
                text: { body: textMessage }
            })
        });
        
        const responseData = await response.json();
        if (responseData.error) {
            console.error("❌ Meta API Error:", responseData.error.message);
        } else {
            console.log(`✅ Message sent successfully to ${recipientPhone}`);
        }
    } catch (err) {
        console.error("❌ Failed to send message:", err.message);
    }
}

// ==========================================
// 3. Conversational Memory Storage
// ==========================================
const chatSessions = {};

// ==========================================
// 4. Webhook Endpoints
// ==========================================

// Webhook Verification (Required by Meta)
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === META_VERIFY_TOKEN) {
            console.log('✅ WEBHOOK VERIFIED BY META');
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    } else {
        res.status(400).send('Invalid verification request');
    }
});

// Receiving Messages from Meta
app.post('/webhook', async (req, res) => {
    // 1. Send 200 OK immediately to prevent Meta from retrying the webhook
    res.sendStatus(200);

    const body = req.body;

    // Make sure this is a WhatsApp status update
    if (body.object !== "whatsapp_business_account") return;

    // Parse the message structure
    if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages) {
        const webhookEvent = body.entry[0].changes[0].value;
        const message = webhookEvent.messages[0];
        
        // We only care about text messages for now
        if (message.type !== "text") return;

        const senderPhone = message.from; // Phone number of the user
        const senderName = webhookEvent.contacts ? webhookEvent.contacts[0].profile.name : senderPhone;
        const text = message.text.body;
        const date = new Date(message.timestamp * 1000).toLocaleString();

        console.log(`📨 Received message from ${senderName}: ${text}`);

        // Handle memory
        if (!chatSessions[senderPhone]) {
            chatSessions[senderPhone] = [];
        }

        chatSessions[senderPhone].push({ role: 'user', content: text });

        if (chatSessions[senderPhone].length > 10) {
            chatSessions[senderPhone] = chatSessions[senderPhone].slice(-10);
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
                ...chatSessions[senderPhone]
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
                // Reply to the user and save the assistant's reply to memory
                await sendWhatsAppMessage(senderPhone, data.reply);
                chatSessions[senderPhone].push({ role: 'assistant', content: data.reply });

            } else if (data.status === 'complete') {
                // We have all details! Log to Sheets and reply.
                await appendToSheet(date, senderName, text, data.name, data.quantity, data.product);
                await sendWhatsAppMessage(senderPhone, `✅ ${data.reply}`);
                
                // Clear memory so they can start a fresh order later
                delete chatSessions[senderPhone];
            }

        } catch (err) {
            console.error('   -> Groq AI Error:', err.message);
            await sendWhatsAppMessage(senderPhone, `⚠️ Oops! The AI encountered an error: ${err.message}\n\nPlease show this error to your developer!`);
        }
    }
});

// A simple landing page
app.get('/', (req, res) => {
    res.send('<h1 style="font-family:sans-serif; text-align:center; margin-top:50px; color:green;">✅ Webhook Server is running perfectly!</h1><p style="text-align:center;">This bot is now connected to the Official Meta API.</p>');
});

app.get('/logs', (req, res) => {
    res.send('<h2>Bot Logs:</h2><pre style="background:#222; color:#0f0; padding:20px; font-size:1.2rem; border-radius:10px;">' + recentLogs.join('<br>') + '</pre>');
});

app.listen(PORT, () => {
    console.log(`🌐 Webhook Server running on port ${PORT}`);
});
