require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const Groq = require('groq-sdk');

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
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

client.on('qr', (qr) => {
    console.log('📱 Scan this QR code with your WhatsApp app to log in:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('✅ WhatsApp Client is ready and listening for messages!');
});

// ==========================================
// 3. Conversational Memory Storage
// ==========================================
// This object stores the chat history for each user based on their phone number.
const chatSessions = {};

client.on('message', async msg => {
    const contact = await msg.getContact();
    const sender = contact.number; // Unique ID for memory
    const senderName = contact.pushname || contact.name || sender;
    const date = new Date(msg.timestamp * 1000).toLocaleString();
    const text = msg.body;

    console.log(`📨 Received message from ${senderName}: ${text}`);

    // Ignore empty messages
    if (!text) return;

    // Initialize memory for new users
    if (!chatSessions[sender]) {
        chatSessions[sender] = [];
    }

    // Add user's message to their history
    chatSessions[sender].push({ role: 'user', content: text });

    // Keep history from getting too long (keep last 10 messages max)
    if (chatSessions[sender].length > 10) {
        chatSessions[sender] = chatSessions[sender].slice(-10);
    }

    try {
        console.log(`   -> Asking Groq AI to analyze the conversation...`);
        
        // System prompt instructs the AI on exactly how to behave
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

        // Call Groq API using a fast model
        const chatCompletion = await groq.chat.completions.create({
            messages: messages,
            model: 'llama3-8b-8192',
            temperature: 0.2,
            response_format: { type: "json_object" } // Enforces JSON output
        });

        const responseText = chatCompletion.choices[0]?.message?.content || '{}';
        const data = JSON.parse(responseText);

        console.log(`   -> Groq Status: ${data.status}`);

        if (data.status === 'asking') {
            // Reply to the user and save the assistant's reply to memory
            await msg.reply(data.reply);
            chatSessions[sender].push({ role: 'assistant', content: data.reply });
            console.log(`   -> Sent follow-up question to ${senderName}`);

        } else if (data.status === 'complete') {
            // We have all details! Log to Sheets and reply.
            await appendToSheet(date, senderName, text, data.name, data.quantity, data.product);
            await msg.reply(`✅ ${data.reply}`);
            console.log(`   -> Sent confirmation and cleared memory for ${senderName}`);
            
            // Clear memory so they can start a fresh order later
            delete chatSessions[sender];
        }

    } catch (err) {
        console.error('   -> Groq AI Error:', err.message);
        
        // Very basic fallback if AI fails entirely
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

// Start the client
client.initialize();
