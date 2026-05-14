// --- POLYFILL START (Wajib ditaruh paling atas) ---
// Ini menipu library pdf-parse agar mengira DOMMatrix sudah ada tanpa install canvas
if (typeof global.DOMMatrix === 'undefined') {
    global.DOMMatrix = class DOMMatrix {
        constructor() {
            this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0;
            this.m11 = 1; this.m12 = 0; this.m21 = 0; this.m22 = 1; this.m41 = 0; this.m42 = 0;
        }
    };
}
// --- POLYFILL END ---

const { r2, GetObjectCommand, getR2BucketName } = require('./r2');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const Tesseract = require('tesseract.js');

const streamToBuffer = async (stream) => {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
};

const chunkText = (text, chunkSize = 1000) => {
    const chunks = [];
    for (let i = 0; i < text.length; i += chunkSize) {
        chunks.push(text.slice(i, i + chunkSize));
    }
    return chunks;
};

const extractContent = async (file) => {
    if (file.storageType !== 'r2' || !file.r2Key) {
        throw new Error('File not in cloud storage.');
    }

    try {
        const command = new GetObjectCommand({
            Bucket: getR2BucketName(),
            Key: file.r2Key
        });
        
        const r2Res = await r2.send(command);
        const buffer = await streamToBuffer(r2Res.Body);
        const mime = file.contentType;

        let text = '';

        if (mime === 'application/pdf') {
            try {
                const data = await pdf(buffer);
                text = data.text;
            } catch (pdfError) {
                console.error("PDF Parse Error:", pdfError);
                text = "Error reading PDF content (encrypted or unsupported format).";
            }
        } 
        else if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
            const result = await mammoth.extractRawText({ buffer });
            text = result.value;
        }
        else if (mime.startsWith('image/')) {
            // Tesseract bisa berat, kita wrap try-catch extra
            try {
                const { data: { text: ocrText } } = await Tesseract.recognize(buffer, 'eng');
                text = `[OCR Result]: ${ocrText}`;
            } catch (ocrError) {
                text = "Image text extraction failed.";
            }
        }
        else if (mime.match(/(text|json|javascript|xml|html|css)/)) {
            text = buffer.toString('utf-8');
        }
        else {
            text = 'Unsupported file type for reading.';
        }

        return text.trim();

    } catch (error) {
        console.error("File Processing Error:", error);
        return "Could not read file content.";
    }
};

const summarizeText = (text) => {
    if (!text) return "No content to summarize.";
    // Simple logic: ambil 5 kalimat pertama
    const sentences = text.split(/[.!?]/).filter(s => s.trim().length > 0);
    const summary = sentences.slice(0, 5).join('. ') + (sentences.length > 5 ? '...' : '');
    return summary;
};

const searchInText = (text, query) => {
    if (!text || !query) return null;
    const chunks = chunkText(text, 500);
    const results = chunks.filter(chunk => chunk.toLowerCase().includes(query.toLowerCase()));
    return results.slice(0, 3).join('\n---\n');
};

module.exports = { extractContent, chunkText, summarizeText, searchInText };
