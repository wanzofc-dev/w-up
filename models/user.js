const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const WebAuthnCredentialSchema = new mongoose.Schema({
  credentialID: { type: Buffer, required: true },
  credentialPublicKey: { type: Buffer, required: true },
  counter: { type: Number, required: true },
  transports: [String],
}, { _id: false });

const BrandingSchema = new mongoose.Schema({
    logoUrl: { type: String },
    logoR2Key: { type: String },
    coverUrl: { type: String },
    primaryColor: { type: String, default: '#4F46E5' },
    pageTitle: { type: String }
}, { _id: false });

const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true },
  password: { type: String, required: true },
  email: { type: String, trim: true, lowercase: true },
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  isBanned: { type: Boolean, default: false },
  banReason: { type: String },
  isVerified: { type: Boolean, default: false },
  plan: { type: String, enum: ['free', 'pro'], default: 'free' },
  subscriptionCycle: { type: String, enum: ['monthly', 'yearly'], default: 'monthly' },
  subscriptionExpiresAt: { type: Date },
  lastPaymentAt: { type: Date },
  storageLimit: { type: Number, default: 1073741824 },
  storageUsed: { type: Number, default: 0 },
  bandwidthLimit: { type: Number, default: 0 },
  walletBalance: { type: Number, default: 0 },
  referralCode: { type: String, unique: true },
  referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  referralCount: { type: Number, default: 0 },
  storageBonus: { type: Number, default: 0 },
  passwordChangedAt: { type: Date, default: Date.now },
  loginAttempts: { type: Number, default: 0 },
  lockUntil: { type: Date },
  isTwoFactorEnabled: { type: Boolean, default: false },
  twoFactorSecret: { ascii: String, otpauth_url: String },
  passkeys: [WebAuthnCredentialSchema],
  currentChallenge: { type: String },
  apiKeys: [{ 
    key: { type: String },
    keyHash: { type: String },
    keyPrefix: { type: String, default: '' },
    label: { type: String, default: 'General' },
    lastUsed: { type: Date },
    createdAt: { type: Date, default: Date.now } 
  }],
  webhook: {
    url: { type: String, default: '' },
    secret: { type: String, default: '' },
    isActive: { type: Boolean, default: false }
  },
  isPublicProfile: { type: Boolean, default: false },
  publicBio: { type: String, default: '' },
  publicTitle: { type: String, default: '' },
  publicThemeColor: { type: String, default: '#2563eb' },
  profilePhotoUrl: { type: String, default: '' },
  profilePhotoR2Key: { type: String, default: '' },
  publicCoverUrl: { type: String, default: '' },
  publicCoverR2Key: { type: String, default: '' },
  branding: { type: BrandingSchema, default: () => ({}) },
  teams: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Team' }],
  sessions: [{
    refreshToken: String, deviceId: String, ip: String,
    os: String, browser: String, location: String,
    lastActive: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now }
  }],
  loginHistory: [{
    ip: String, os: String, browser: String, location: String,
    date: { type: Date, default: Date.now }
  }],
  failedLogins: [{
    ip: String, reason: String, date: { type: Date, default: Date.now }
  }],
  createdAt: { type: Date, default: Date.now }
});

UserSchema.pre('save', async function(next) {
  if (!this.referralCode) {
    let referralCode = '';
    let exists = true;

    while (exists) {
      referralCode = Math.random().toString(36).substring(2, 8).toUpperCase();
      exists = await this.constructor.exists({ referralCode, _id: { $ne: this._id } });
    }

    this.referralCode = referralCode;
  }
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  this.passwordChangedAt = Date.now();
  next();
});

UserSchema.methods.comparePassword = function(candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('User', UserSchema);
