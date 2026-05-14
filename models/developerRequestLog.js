const mongoose = require('mongoose');

const DeveloperRequestLogSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  feature: { type: String, default: '' },
  category: { type: String, default: 'developer' },
  method: { type: String, default: 'GET' },
  path: { type: String, default: '' },
  statusCode: { type: Number, default: 200 },
  authType: { type: String, enum: ['cookie', 'bearer', 'api_key', 'system'], default: 'cookie' },
  bytes: { type: Number, default: 0 },
  meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  createdAt: { type: Date, default: Date.now, index: true }
});

DeveloperRequestLogSchema.index({ user: 1, createdAt: -1 });
DeveloperRequestLogSchema.index({ user: 1, feature: 1, createdAt: -1 });

module.exports = mongoose.model('DeveloperRequestLog', DeveloperRequestLogSchema);
