const axios = require('axios');
const translationCache = new Map();
const BATCH_SEPARATOR = '\n__WU_TRANSLATION_SPLIT__\n';
const BATCH_CACHE_LIMIT = 1000;

const languages = [
    { code: 'id', name: 'Indonesian' },
    { code: 'en', name: 'English' },
    { code: 'es', name: 'Spanish' },
    { code: 'ja', name: 'Japanese' },
    { code: 'fr', name: 'French' },
    { code: 'de', name: 'German' },
    { code: 'ru', name: 'Russian' },
    { code: 'zh-cn', name: 'Chinese' },
    { code: 'ko', name: 'Korean' },
    { code: 'ar', name: 'Arabic' },
    { code: 'pt', name: 'Portuguese' },
    { code: 'it', name: 'Italian' },
    { code: 'nl', name: 'Dutch' },
    { code: 'sv', name: 'Swedish' },
    { code: 'pl', name: 'Polish' },
    { code: 'tr', name: 'Turkish' },
    { code: 'hi', name: 'Hindi' },
    { code: 'th', name: 'Thai' },
    { code: 'vi', name: 'Vietnamese' },
    { code: 'ms', name: 'Malay' },
    { code: 'bn', name: 'Bengali' },
    { code: 'fa', name: 'Persian' },
    { code: 'ur', name: 'Urdu' },
    { code: 'he', name: 'Hebrew' },
    { code: 'el', name: 'Greek' },
    { code: 'hu', name: 'Hungarian' },
    { code: 'cs', name: 'Czech' },
    { code: 'ro', name: 'Romanian' },
    { code: 'bg', name: 'Bulgarian' },
    { code: 'uk', name: 'Ukrainian' },
    { code: 'sr', name: 'Serbian' },
    { code: 'hr', name: 'Croatian' },
    { code: 'sk', name: 'Slovak' },
    { code: 'da', name: 'Danish' },
    { code: 'no', name: 'Norwegian' },
    { code: 'fi', name: 'Finnish' },
    { code: 'et', name: 'Estonian' },
    { code: 'lv', name: 'Latvian' },
    { code: 'lt', name: 'Lithuanian' },
    { code: 'sl', name: 'Slovenian' }
];

async function translateText(text, targetLang, sourceLang = 'auto') {
    if (!text) return '';
    
    const cacheKey = `${text}_${targetLang}_${sourceLang}`;
    if (translationCache.has(cacheKey)) {
        return translationCache.get(cacheKey);
    }

    try {
        const encodedText = encodeURIComponent(text);
        const url = `https://translate.google.com/translate_a/single?client=gtx&sl=${sourceLang}&tl=${targetLang}&dt=t&q=${encodedText}`;

        const response = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });

        if (response.data && response.data[0]) {
            const translatedText = response.data[0].map(item => item[0]).join('');
            translationCache.set(cacheKey, translatedText);
            
            if (translationCache.size > 1000) translationCache.clear();
            
            return translatedText;
        }
        return text;
    } catch (error) {
        console.error('Translation Error:', error.message);
        return text;
    }
}

async function requestGoogleTranslation(text, targetLang, sourceLang = 'auto') {
    const encodedText = encodeURIComponent(text);
    const url = `https://translate.google.com/translate_a/single?client=gtx&sl=${sourceLang}&tl=${targetLang}&dt=t&q=${encodedText}`;

    const response = await axios.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 10000
    });

    if (response.data && response.data[0]) {
        return response.data[0].map(item => item[0]).join('');
    }

    return text;
}

async function translateBatch(texts, targetLang, sourceLang = 'auto') {
    if (!Array.isArray(texts) || !texts.length) return [];

    const normalizedTexts = texts.map(text => (typeof text === 'string' ? text : ''));
    const indexedPending = [];
    const results = new Array(normalizedTexts.length);

    normalizedTexts.forEach((text, index) => {
        const cacheKey = `${text}_${targetLang}_${sourceLang}`;
        if (!text) {
            results[index] = '';
            return;
        }

        if (translationCache.has(cacheKey)) {
            results[index] = translationCache.get(cacheKey);
            return;
        }

        indexedPending.push({ index, text, cacheKey });
    });

    if (!indexedPending.length) {
        return results;
    }

    try {
        const mergedText = indexedPending.map(item => item.text).join(BATCH_SEPARATOR);
        const translatedMergedText = await requestGoogleTranslation(mergedText, targetLang, sourceLang);
        const translatedParts = translatedMergedText.split(BATCH_SEPARATOR);

        if (translatedParts.length === indexedPending.length) {
            indexedPending.forEach((item, offset) => {
                const translated = translatedParts[offset] || item.text;
                translationCache.set(item.cacheKey, translated);
                results[item.index] = translated;
            });

            if (translationCache.size > BATCH_CACHE_LIMIT) translationCache.clear();
            return results.map((value, index) => value ?? normalizedTexts[index]);
        }
    } catch (error) {
        console.error('Batch Translation Error:', error.message);
    }

    for (const item of indexedPending) {
        results[item.index] = await translateText(item.text, targetLang, sourceLang);
    }

    return results.map((value, index) => value ?? normalizedTexts[index]);
}

module.exports = { translateText, translateBatch, languages };
