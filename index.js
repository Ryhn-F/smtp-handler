require('dotenv').config();
const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Nodemailer SMTP Transporter setup
// Provide these in your .env file
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT || 587,
  secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// SMTP Endpoint
app.post('/api/send-email', async (req, res) => {
  const { name, email, subject, message } = req.body;

  // Validate payload
  if (!name || !email || !subject || !message) {
    return res.status(400).json({ 
      success: false, 
      error: 'All fields are required (name, email, subject, message)' 
    });
  }

  try {
    // Send email
    const info = await transporter.sendMail({
      from: `"${name}" <${process.env.SMTP_USER}>`, // Send from your authenticated SMTP user
      replyTo: email, // Set the reply-to header to the user's email
      to: process.env.RECEIVER_EMAIL || process.env.SMTP_USER, // The email address that will receive the message
      subject: `New Contact Form Submission: ${subject}`, 
      text: `You have received a new message from ${name} (${email}).\n\nMessage:\n${message}`,
      html: `
        <h3>New Contact Message</h3>
        <p><strong>Name:</strong> ${name}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Subject:</strong> ${subject}</p>
        <p><strong>Message:</strong></p>
        <p>${message.replace(/\n/g, '<br/>')}</p>
      `,
    });

    console.log('Message sent: %s', info.messageId);
    return res.status(200).json({ success: true, message: 'Email sent successfully!' });
  } catch (error) {
    console.error('Error sending email:', error);
    return res.status(500).json({ success: false, error: 'Failed to send email. Please try again later.' });
  }
});

// Basic health check route
app.get('/', (req, res) => {
  res.send('SMTP API is running.');
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
