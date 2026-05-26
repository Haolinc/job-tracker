import dotenv from 'dotenv';
dotenv.config();

const required = ['MONGODB_URI', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI', 'SESSION_SECRET'];
for (const key of required) {
	if (!process.env[key]) {
		console.error(`ERROR: ${key} is not set. Add it to your .env file.`);
		process.exit(1);
	}
}

import express from 'express';
import cors from 'cors';
import session from 'express-session';
import MongoStore from 'connect-mongo';
import { connect } from './services/db';
import applicationsRouter from './routes/applications';
import authRouter from './routes/auth';
import gmailRouter from './routes/gmail';
import './types';

const app = express();

app.use(cors({
	origin: process.env.CLIENT_URL || 'http://localhost:5173',
	credentials: true,
}));

app.use(express.json());

app.use(session({
	secret: process.env.SESSION_SECRET!,
	resave: false,
	saveUninitialized: false,
	cookie: { secure: process.env.NODE_ENV === 'production', httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 },
	store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI! }),
}));

app.use('/api/applications', applicationsRouter);
app.use('/api/auth', authRouter);
app.use('/api/gmail', gmailRouter);

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3001;

connect()
	.then(() => {
		console.log('Connected to MongoDB');
		app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
	})
	.catch(err => {
		console.error('Failed to connect to MongoDB:', err);
		process.exit(1);
	});
