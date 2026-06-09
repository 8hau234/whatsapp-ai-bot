const express = require('express');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

// The Verify Token you set in the Meta App Dashboard
const VERIFY_TOKEN = "aurel_globe_secret_123";

// ==========================================
// 1. Webhook Verification (GET)
// Meta sends a GET request to verify you own this URL
// ==========================================
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    // Check if a request is for subscription verification
    if (mode && token) {
        // Check the mode and token sent are correct
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('WEBHOOK_VERIFIED');
            // Respond with 200 OK and challenge token from the request
            res.status(200).send(challenge);
        } else {
            // Responds with '403 Forbidden' if verify tokens do not match
            res.sendStatus(403);
        }
    } else {
        res.status(400).send('Invalid verification request');
    }
});

// ==========================================
// 2. Receiving Messages (POST)
// Meta sends a POST request whenever a user messages your WhatsApp number
// ==========================================
app.post('/webhook', (req, res) => {
    let body = req.body;

    // Check the incoming webhook message
    console.log(JSON.stringify(body, null, 2));

    // Acknowledge receipt of the webhook to prevent Meta from retrying
    res.sendStatus(200);
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Webhook server is listening on port ${PORT}`);
    console.log(`Ensure your tunneling service (e.g. ngrok) points to http://localhost:${PORT}`);
});
