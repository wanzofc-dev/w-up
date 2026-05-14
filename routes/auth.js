const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const geoip = require('geoip-lite');
const useragent = require('useragent');
const speakeasy = require('speakeasy');
const User = require('../models/user');
const { loginLimiter, registerLimiter } = require('../middleware/limiters');
const {
    generatePasskeyLoginOptions,
    verifyPasskeyLogin
} = require('../utils/passkey');

const router = express.Router();

const PASS_EXPIRY_DAYS = 90;
const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_TIME = 15 * 60 * 1000; 

function escapeRegex(value = '') {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function findUserByUsername(username) {
    const cleanUsername = typeof username === 'string' ? username.trim() : '';
    if (!cleanUsername) return null;
    return User.findOne({ username: { $regex: new RegExp(`^${escapeRegex(cleanUsername)}$`, 'i') } });
}

function normalizeEmail(email) {
    return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

async function findUserByEmail(email) {
    const cleanEmail = normalizeEmail(email);
    if (!cleanEmail) return null;
    return User.findOne({ email: cleanEmail });
}

function getCookieOptions(req, maxAge) {
    const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    return {
        httpOnly: true,
        sameSite: 'lax',
        secure: Boolean(isSecure),
        maxAge
    };
}

function getLocationFromRequest(ip) {
    const geo = geoip.lookup(ip);
    return geo ? `${geo.city || 'Unknown City'}, ${geo.country}` : 'Unknown';
}

async function createUserSession(req, res, user, locationOverride) {
    const ip = req.ip || req.connection.remoteAddress;
    const agent = useragent.parse(req.headers['user-agent']);
    const deviceId = crypto.randomBytes(16).toString('hex');
    const accessToken = jwt.sign({ id: user._id, username: user.username }, process.env.JWT_SECRET, { expiresIn: '15m' });
    const refreshToken = jwt.sign({ id: user._id, deviceId }, process.env.JWT_SECRET, { expiresIn: '7d' });

    user.loginAttempts = 0;
    user.lockUntil = undefined;
    user.sessions.push({
        refreshToken,
        deviceId,
        ip,
        os: agent.os.toString(),
        browser: agent.toAgent(),
        location: locationOverride || getLocationFromRequest(ip)
    });

    user.loginHistory.push({
        ip,
        os: agent.os.toString(),
        browser: agent.toAgent(),
        location: locationOverride || getLocationFromRequest(ip)
    });

    if (user.loginHistory.length > 20) user.loginHistory.shift();
    await user.save();

    res.clearCookie('temp_token', getCookieOptions(req, 0));
    res.cookie('token', accessToken, getCookieOptions(req, 900000));
    res.cookie('refresh_token', refreshToken, getCookieOptions(req, 604800000));
}

router.post('/register', registerLimiter, async (req, res) => {
    try {
        const { username, password, referralCode, email } = req.body;
        const cleanUsername = typeof username === 'string' ? username.trim() : '';
        const cleanReferralCode = typeof referralCode === 'string' ? referralCode.trim().toUpperCase() : '';
        const cleanEmail = normalizeEmail(email);

        if (!cleanUsername || !password) return res.status(400).json({ message: 'Required fields missing.' });
        if (cleanUsername.length < 3) return res.status(400).json({ message: 'Username must be at least 3 characters.' });
        if (password.length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters.' });
        if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
            return res.status(400).json({ message: 'Email format is invalid.' });
        }
        
        const existingUser = await findUserByUsername(cleanUsername);
        if (existingUser) return res.status(400).json({ message: 'Username exists.' });
        if (cleanEmail) {
            const existingEmail = await findUserByEmail(cleanEmail);
            if (existingEmail) return res.status(400).json({ message: 'Email already in use.' });
        }

        let referrer = null;
        if (cleanReferralCode) {
            referrer = await User.findOne({ referralCode: cleanReferralCode });
            if (referrer) {
                referrer.storageBonus += 52428800;
                referrer.referralCount += 1;
                await referrer.save();
            }
        }

        const user = new User({ 
            username: cleanUsername, 
            password, 
            email: cleanEmail || undefined,
            referredBy: referrer?._id, 
            storageBonus: referrer ? 52428800 : 0 
        });
        await user.save();
        res.status(201).json({ message: 'User registered.' });
    } catch (error) {
        if (error && error.code === 11000) {
            if (error.keyPattern?.username) return res.status(400).json({ message: 'Username exists.' });
            if (error.keyPattern?.referralCode) return res.status(503).json({ message: 'Please retry registration.' });
        }
        console.error('Register error:', error);
        res.status(500).json({ message: 'Registration failed.' });
    }
});

router.post('/login', loginLimiter, async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await findUserByUsername(username);
        const ip = req.ip || req.connection.remoteAddress;
        
        if (!user) return res.status(401).json({ message: 'Invalid credentials.' });
        if (user.isBanned) return res.status(403).json({ message: 'Account banned.' });

        if (user.lockUntil && user.lockUntil > Date.now()) {
            return res.status(423).json({ 
                message: `Account locked. Try again after ${new Date(user.lockUntil).toLocaleTimeString()}` 
            });
        }

        const isMatch = await user.comparePassword(password);
        if (!isMatch) {
            user.loginAttempts += 1;
            user.failedLogins.push({ ip, reason: 'Wrong Password' });
            
            if (user.loginAttempts >= MAX_LOGIN_ATTEMPTS) {
                user.lockUntil = Date.now() + LOCK_TIME;
                user.failedLogins.push({ ip, reason: 'Account Locked' });
            }
            await user.save();
            return res.status(401).json({ 
                message: user.lockUntil ? 'Account locked due to too many failed attempts.' : 'Invalid credentials.' 
            });
        }

        const daysSinceChange = (Date.now() - new Date(user.passwordChangedAt).getTime()) / (1000 * 60 * 60 * 24);
        if (daysSinceChange > PASS_EXPIRY_DAYS) {
            return res.status(403).json({ status: 'password_expired', message: 'Password expired. Please change it.' });
        }

        user.loginAttempts = 0;
        user.lockUntil = undefined;

        if (user.isTwoFactorEnabled) {
            const tempToken = jwt.sign({ id: user._id, partial: true }, process.env.JWT_SECRET, { expiresIn: '5m' });
            res.cookie('temp_token', tempToken, getCookieOptions(req, 300000));
            await user.save();
            return res.status(200).json({ status: '2fa_required', message: '2FA required.' });
        }
        
        await createUserSession(req, res, user);
        res.status(200).json({ message: 'Login successful.' });
    } catch (error) {
        res.status(500).json({ message: 'Login error.' });
    }
});

router.post('/login/2fa', async (req, res) => {
    const { code } = req.body;
    const tempToken = req.cookies.temp_token;
    if(!tempToken) return res.status(401).json({ message: 'Session expired.' });

    try {
        const decoded = jwt.verify(tempToken, process.env.JWT_SECRET);
        const user = await User.findById(decoded.id);
        if (!user) return res.status(401).json({ message: 'Session expired.' });
        if (user.isBanned) return res.status(403).json({ message: 'Account banned.' });
        
        const verified = speakeasy.totp.verify({
            secret: user.twoFactorSecret.ascii,
            encoding: 'ascii',
            token: code
        });

        if(verified) {
            await createUserSession(req, res, user, 'Unknown (2FA)');
            res.json({ message: 'Login successful' });
        } else {
            res.status(400).json({ message: 'Invalid 2FA code' });
        }
    } catch(e) {
        res.status(401).json({ message: 'Error verifying 2FA' });
    }
});

router.post('/refresh-token', async (req, res) => {
    try {
        const oldRefreshToken = req.cookies.refresh_token;
        if (!oldRefreshToken) return res.status(401).json({ message: 'No refresh token.' });

        const decoded = jwt.verify(oldRefreshToken, process.env.JWT_SECRET);
        const user = await User.findById(decoded.id);
        if (!user) return res.status(403).json({ message: 'User not found.' });

        const sessionIndex = user.sessions.findIndex(s => s.refreshToken === oldRefreshToken);
        if (sessionIndex === -1) {
            res.clearCookie('token');
            res.clearCookie('refresh_token');
            return res.status(403).json({ message: 'Invalid session.' });
        }

        const newAccessToken = jwt.sign({ id: user._id, username: user.username }, process.env.JWT_SECRET, { expiresIn: '15m' });
        const newRefreshToken = jwt.sign({ id: user._id, deviceId: decoded.deviceId }, process.env.JWT_SECRET, { expiresIn: '7d' });

        user.sessions[sessionIndex].refreshToken = newRefreshToken;
        user.sessions[sessionIndex].lastActive = Date.now();
        await user.save();

        res.cookie('token', newAccessToken, getCookieOptions(req, 900000));
        res.cookie('refresh_token', newRefreshToken, getCookieOptions(req, 604800000));

        res.json({ message: 'Token refreshed.' });
    } catch (error) {
        res.status(403).json({ message: 'Invalid refresh token.' });
    }
});

router.post('/passkey/login-options', async (req, res) => {
    try {
        const { username } = req.body;
        let user;
        if (username) {
            user = await findUserByUsername(username);
        }
        
        const options = await generatePasskeyLoginOptions(user);
        
        if (options.error) {
            return res.status(404).json({ error: options.error });
        }
        
        res.json(options);
    } catch(e) {
        console.error('Error generating login options:', e);
        res.status(500).json({ error: e.message });
    }
});

router.post('/passkey/verify-login', async (req, res) => {
    const { id, response } = req.body;
    try {
        if (!id) return res.status(400).json({ error: "Credential ID is missing." });

        const credentialIdBuffer = Buffer.from(id, 'base64url');
        
        let user = await User.findOne({
            'passkeys.credentialID': credentialIdBuffer
        });

        if (!user && response && response.userHandle) {
            try {
                const handleBuffer = Buffer.from(response.userHandle, 'base64');
                const userIdHex = handleBuffer.toString('utf-8');
                if (/^[0-9a-fA-F]{24}$/.test(userIdHex)) {
                    user = await User.findById(userIdHex);
                }
            } catch (err) {}
        }

        if (!user) {
            return res.status(404).json({ error: "User not found or passkey not linked." });
        }
        if (user.isBanned) {
            return res.status(403).json({ error: "Account banned." });
        }

        const verification = await verifyPasskeyLogin(user, req.body);

        if (verification.verified) {
            await createUserSession(req, res, user);
            return res.json({ verified: true, message: 'Passkey login successful.' });
        }

        res.status(400).json({ verified: false, error: 'Verification failed' });
    } catch (e) {
        console.error('Error verifying login:', e);
        res.status(400).json({ error: e.message });
    }
});

router.get('/logout', async (req, res) => {
    const refreshToken = req.cookies.refresh_token;
    if (refreshToken) {
        try {
            const decoded = jwt.verify(refreshToken, process.env.JWT_SECRET);
            await User.updateOne({ _id: decoded.id }, { $pull: { sessions: { refreshToken } } });
        } catch(e) {}
    }
    res.clearCookie('token');
    res.clearCookie('refresh_token');
    res.clearCookie('temp_token');
    res.redirect('/login');
});

module.exports = router;
