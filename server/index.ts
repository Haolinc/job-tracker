import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import session from 'express-session';
import path from 'path';
import fs from 'fs';
import applicationsRouter from './routes/applications';
import authRouter from './routes/auth';
import gmailRouter from './routes/gmail';
import './types';

const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const app = express();

app.use(cors({
	origin: process.env.CLIENT_URL || 'http://localhost:5173',
	credentials: true,
}));

app.use(express.json());

app.use(session({
	secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
	resave: false,
	saveUninitialized: false,
	cookie: { secure: false, httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 },
}));

app.use('/api/applications', applicationsRouter);
app.use('/api/auth', authRouter);
app.use('/api/gmail', gmailRouter);

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
