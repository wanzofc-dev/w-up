const mongoose = require('mongoose');

const UploadSessionSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  filename: String,
  contentType: String,
  totalSize: Number,
  uploadedSize: { type: Number, default: 0 },
  r2Key: String,
  r2UploadId: String,
  parts: [{
    partNumber: Number,
    etag: String,
    size: Number
  }],
  createdAt: { type: Date, default: Date.now, expires: 86400 } 
});

module.exports = mongoose.model('UploadSession', UploadSessionSchema);
