const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const File = require('../models/file');
const User = require('../models/user');
const Team = require('../models/team');
const FileRequest = require('../models/fileRequest');
const AiLog = require('../models/aiLog');
const AiInsight = require('../models/aiInsight');
const { extractContent, summarizeText, searchInText } = require('../utils/fileProcessor');
const { translateText } = require('../utils/tr');
const { getDocsContent } = require('../utils/docsLoader');
const { r2, GetObjectCommand } = require('../utils/r2');
const auth = require('../middleware/auth');
const { aiSecurityGuard } = require('../middleware/aiSecurity');
const { getUserProfile, getStorageStats, getWorkspaceIntelligence, searchUsers, getTeamData, getActivityLog, AI_SCHEMA_MAP } = require('../utils/aiHelpers');
const { formatFileResults, parseDateRange, searchFileContent, findSimilarFilesByName } = require('../utils/aiSearchHelpers');
const { isOpenRouterEnabled, requestOpenRouterReply } = require('../utils/openrouterClient');

function maskPII(text) {
    return text.replace(/\b[\w.-]+@[\w.-]+\.\w{2,4}\b/g, '[EMAIL PROTECTED]').replace(/\b(\+62|0)[0-9]{9,12}\b/g, '[PHONE PROTECTED]');
}

function cleanEntity(str) {
    if (!str) return '';
    return str.trim().replace(/^['"]|['"]$/g, '');
}

function formatInsightMarkdown(insight) {
    const suggestions = (insight.metadata?.suggestions || [])
        .filter(Boolean)
        .map(item => `- ${item}`)
        .join('\n');

    return [
        `**${insight.title}**`,
        insight.summary,
        suggestions
    ].filter(Boolean).join('\n\n');
}

router.post('/chat', auth.protectApi, aiSecurityGuard, async (req, res) => {
    try {
        const { message, context, history } = req.body;
        const userId = req.user.id;
        const userTeams = req.user.teams || [];
        const userRole = req.user.role;
        const userLang = context.language ? context.language.split('-')[0] : 'en';
        const englishQuery = await translateText(message, 'en', 'auto');
        const cleanMsg = englishQuery.toLowerCase().trim();

        let responseText = "";
        let action = null;
        let match;
        let usedOpenRouterReply = false;

        // --- NEW Regex-based command parsing ---

        if (match = cleanMsg.match(/rename file (.+?) to (.+)/)) {
            const oldName = cleanEntity(match[1]);
            const newName = cleanEntity(match[2]);
            const file = await File.findOneAndUpdate({ owner: userId, originalName: { $regex: new RegExp(`^${oldName}$`, 'i') }, deletedAt: null }, { originalName: newName });
            responseText = file ? `Renamed "${oldName}" to "${newName}".` : `File "${oldName}" not found.`;
        }
        
        else if (match = cleanMsg.match(/move file (.+?) to (folder )?(.+)/)) {
            const fileName = cleanEntity(match[1]);
            const folderName = cleanEntity(match[3]);
            const fileToMove = await File.findOne({ owner: userId, originalName: { $regex: new RegExp(`^${fileName}$`, 'i') }, deletedAt: null });
            const targetFolder = await File.findOne({ owner: userId, originalName: { $regex: new RegExp(`^${folderName}$`, 'i') }, isFolder: true, deletedAt: null });
            if (!fileToMove) responseText = `File "${fileName}" not found.`;
            else if (!targetFolder) responseText = `Folder "${folderName}" not found.`;
            else {
                fileToMove.parentId = targetFolder._id;
                await fileToMove.save();
                responseText = `Moved "${fileName}" to "${folderName}".`;
            }
        }
        
        else if (match = cleanMsg.match(/^(delete|trash) file (.+)/)) {
            const fileName = cleanEntity(match[2]);
            const file = await File.findOneAndUpdate({ owner: userId, originalName: { $regex: new RegExp(`^${fileName}$`, 'i') }, deletedAt: null }, { deletedAt: new Date() });
            responseText = file ? `Moved "${fileName}" to trash.` : `File "${fileName}" not found.`;
        }
        
        else if (match = cleanMsg.match(/add tag (.+?) to (file )?(.+)/)) {
            const tagName = cleanEntity(match[1]);
            const fileName = cleanEntity(match[3]);
            const file = await File.findOneAndUpdate({ owner: userId, originalName: { $regex: new RegExp(`^${fileName}$`, 'i') }, deletedAt: null }, { $addToSet: { tags: tagName } });
            responseText = file ? `Added tag "${tagName}" to "${fileName}".` : `File "${fileName}" not found.`;
        }

        else if (match = cleanMsg.match(/remove tag (.+?) from (file )?(.+)/)) {
            const tagName = cleanEntity(match[1]);
            const fileName = cleanEntity(match[3]);
            const file = await File.findOneAndUpdate({ owner: userId, originalName: { $regex: new RegExp(`^${fileName}$`, 'i') }, deletedAt: null }, { $pull: { tags: tagName } });
            responseText = file ? `Removed tag "${tagName}" from "${fileName}".` : `File "${fileName}" not found.`;
        }
        
        else if (match = cleanMsg.match(/protect (file )?(.+?) with password (.+)/)) {
            const fileName = cleanEntity(match[2]);
            const password = cleanEntity(match[3]);
            const file = await File.findOne({ owner: userId, originalName: { $regex: new RegExp(`^${fileName}$`, 'i') }, deletedAt: null });
            if (!file) responseText = `File "${fileName}" not found.`;
            else {
                file.password = await bcrypt.hash(password, 10);
                await file.save();
                responseText = `"${fileName}" is now password protected.`;
            }
        }
        
        else if (match = cleanMsg.match(/^create (a new )?folder (named )?(.+)/)) {
            const folderName = cleanEntity(match[3]);
            await new File({ originalName: folderName, customAlias: `folder_${Date.now()}`, contentType: 'application/vnd.google-apps.folder', size: 0, owner: userId, isFolder: true }).save();
            responseText = `Folder "${folderName}" created successfully.`;
        }
        
        else if (match = cleanMsg.match(/share (file )?(.+?) with (.+)/)) {
            const fileName = cleanEntity(match[2]);
            const targetIdentifier = cleanEntity(match[3]);
            const file = await File.findOne({ owner: userId, originalName: { $regex: new RegExp(`^${fileName}$`, 'i') }, deletedAt: null });
            const targetUser = await User.findOne({ $or: [{ email: targetIdentifier }, { username: targetIdentifier }] });
            if(!file) responseText = `File "${fileName}" not found.`;
            else if (!targetUser) responseText = `User "${targetIdentifier}" not found.`;
            else {
                await File.updateOne({ _id: file._id }, { $addToSet: { collaborators: targetUser._id } });
                responseText = `Shared "${fileName}" with ${targetUser.username}.`;
            }
        }

        else if (match = cleanMsg.match(/add user (.+?) to the (.+?) team/)) {
            const username = cleanEntity(match[1]);
            const teamName = cleanEntity(match[2]);
            const team = await Team.findOne({ name: { $regex: new RegExp(`^${teamName}$`, 'i') }, members: userId });
            const userToAdd = await User.findOne({ username });
            if(!team) responseText = `Team "${teamName}" not found or you're not a member.`;
            else if (!userToAdd) responseText = `User "${username}" not found.`;
            else {
                await Team.updateOne({ _id: team._id }, { $addToSet: { members: userToAdd._id } });
                await User.updateOne({ _id: userToAdd._id }, { $addToSet: { teams: team._id } });
                responseText = `Added ${username} to the ${team.name} team.`;
            }
        }

        else if (match = cleanMsg.match(/generate a file request link for (.+)/)) {
            const label = cleanEntity(match[1]);
            const slug = Math.random().toString(36).substring(2, 10);
            const reqFile = new FileRequest({ owner: userId, slug, label });
            await reqFile.save();
            const link = `${req.protocol}://${req.get('host')}/req/${slug}`;
            responseText = `File request link for "${label}" created: ${link}`;
            action = { type: 'copy', text: link };
        }
        
        else if (cleanMsg.match(/empty my trash/)) {
            await File.deleteMany({ owner: userId, deletedAt: { $ne: null } });
            responseText = "Your trash bin has been emptied.";
        }
        
        else if (match = cleanMsg.match(/^(summarize|read|open) (file )?(.+)/)) {
            const actionType = match[1];
            const fileName = cleanEntity(match[3]);
            if (fileName === '[filename]') {
                responseText = `Please specify a filename to ${actionType}.`;
            } else {
                const file = await File.findOne({ owner: userId, originalName: { $regex: new RegExp(`^${fileName}$`, 'i') }, deletedAt: null });
                if (!file) {
                    responseText = `File "${fileName}" not found.`;
                } else {
                    const content = await extractContent(file);
                    if (actionType === 'summarize') {
                        responseText = `**Summary of ${file.originalName}:**\n\n${summarizeText(content)}`;
                    } else {
                        responseText = `**${file.originalName}**:\n\`\`\`\n${content.substring(0, 800)}\n\`\`\``;
                    }
                }
            }
        }
        
        // --- ORIGINAL CODE (KEPT AS FALLBACK) ---

        else if (cleanMsg.startsWith('find photos with') || cleanMsg.startsWith('show me photos of')) {
            const query = cleanMsg.replace(/^(find photos with|show me photos of)/, '').trim();
            responseText = "Image content search is an advanced feature. As a fallback, I'm searching user tags and descriptions for your query...\n\n";
            const files = await File.find({ owner: userId, contentType: /^image\//, deletedAt: null, $or: [{ tags: query }, { description: new RegExp(query, 'i') }] });
            responseText += formatFileResults(files);
        }
        
        else if (cleanMsg.startsWith('find documents that mention')) {
            const query = cleanMsg.replace('find documents that mention', '').trim();
            const files = await searchFileContent(userId, userTeams, query);
            responseText = `Found ${files.length} documents mentioning "${query}":\n\n` + formatFileResults(files);
        }
        
        else if (cleanMsg.startsWith('show me all files uploaded')) {
            const dateRange = parseDateRange(cleanMsg);
            if(dateRange) {
                const files = await File.find({ owner: userId, createdAt: dateRange, deletedAt: null });
                responseText = `Found ${files.length} files matching that date range:\n\n` + formatFileResults(files);
            } else {
                responseText = "I couldn't understand that date range. Try 'today', 'yesterday', or 'last 7 days'.";
            }
        }
        
        else if (cleanMsg.startsWith('find all')) {
            let dbQuery = { owner: userId, deletedAt: null };
            const typeMatch = cleanMsg.match(/(pdf|image|video|document) files/);
            const tagMatch = cleanMsg.match(/tagged as (.+?)( larger| smaller|$)/);
            const sizeMatch = cleanMsg.match(/(larger|smaller) than (\d+)\s?(mb|gb|kb)/);

            if (typeMatch) {
                if(typeMatch[1] === 'image') dbQuery.contentType = /^image\//;
                else if(typeMatch[1] === 'video') dbQuery.contentType = /^video\//;
                else dbQuery.contentType = new RegExp(typeMatch[1], 'i');
            }
            if (tagMatch) dbQuery.tags = tagMatch[1].trim();
            if (sizeMatch) {
                const size = parseInt(sizeMatch[2]);
                const unit = sizeMatch[3];
                const multiplier = unit === 'gb' ? 1024*1024*1024 : unit === 'mb' ? 1024*1024 : 1024;
                dbQuery.size = sizeMatch[1] === 'larger' ? { $gt: size * multiplier } : { $lt: size * multiplier };
            }
            const files = await File.find(dbQuery);
            responseText = `Found ${files.length} files matching your combined filter:\n\n` + formatFileResults(files);
        }
        
        else if (cleanMsg.startsWith('find files similar to')) {
            const fileName = cleanMsg.replace('find files similar to', '').trim();
            const files = await findSimilarFilesByName(userId, fileName);
            responseText = `Found ${files.length} files with names similar to "${fileName}":\n\n` + formatFileResults(files);
        }

        else if (cleanMsg.startsWith('search for')) {
            const teamMatch = cleanMsg.match(/search for (.+?) in all my teams/);
            if (teamMatch) {
                const query = teamMatch[1].trim();
                const teams = await Team.find({ _id: { $in: userTeams } });
                const memberIds = [...new Set(teams.flatMap(t => t.members))];
                const files = await File.find({ owner: { $in: memberIds }, originalName: new RegExp(query, 'i'), deletedAt: null });
                responseText = `Found ${files.length} files for "${query}" across all your teams:\n\n` + formatFileResults(files);
            }
        }

        else if (cleanMsg.startsWith('sort my files by')) {
            let sort = {};
            if (cleanMsg.includes('size')) sort.size = cleanMsg.includes('largest') ? -1 : 1;
            else if (cleanMsg.includes('name')) sort.originalName = cleanMsg.includes('z to a') ? -1 : 1;
            else if (cleanMsg.includes('date')) sort.createdAt = cleanMsg.includes('newest') ? -1 : 1;
            const files = await File.find({ owner: userId, parentId: null, deletedAt: null }).sort(sort).limit(10);
            responseText = `Here are your top files sorted as requested:\n\n` + formatFileResults(files);
        }

        else if (cleanMsg.startsWith('show me my most')) {
            let sort = {};
            if (cleanMsg.includes('downloaded')) sort.downloads = -1;
            else if (cleanMsg.includes('recent')) sort.createdAt = -1;
            const files = await File.find({ owner: userId, deletedAt: null }).sort(sort).limit(5);
            responseText = `Here are your most ${cleanMsg.includes('downloaded') ? 'downloaded' : 'recent'} files:\n\n` + formatFileResults(files);
        }
        
        else if (cleanMsg.startsWith('find what user')) {
            const username = cleanMsg.replace('find what user', '').replace('has shared publicly', '').trim();
            const targetUser = await User.findOne({ username, isPublicProfile: true });
            if (!targetUser) responseText = `User "${username}" not found or their profile is private.`;
            else {
                const files = await File.find({ owner: targetUser._id, isHidden: false, deletedAt: null, password: { $exists: false } }).limit(10);
                responseText = `Here are the latest public files from ${username}:\n\n` + formatFileResults(files);
            }
        }
        
        else if (cleanMsg.startsWith('find file')) {
            const filename = cleanMsg.replace('find file', '').trim();
            const file = await File.findOne({ owner: userId, originalName: { $regex: filename, $options: 'i' }, deletedAt: null });
            if (file) {
                responseText = `I found "${file.originalName}". What would you like to do with it? (e.g., 'summarize it', 'delete it')`;
                action = { type: 'context', fileId: file._id.toString() };
            } else {
                responseText = `I couldn't find a file named "${filename}".`;
            }
        }
        
        else if (cleanMsg.startsWith('rename file')) {
            const parts = cleanMsg.replace('rename file', '').split(' to ');
            if (parts.length === 2) {
                const oldName = parts[0].trim();
                const newName = parts[1].trim();
                const file = await File.findOneAndUpdate({ owner: userId, originalName: { $regex: new RegExp(`^${oldName}$`, 'i') }, deletedAt: null }, { originalName: newName });
                responseText = file ? `Renamed "${oldName}" to "${newName}".` : `File "${oldName}" not found.`;
            }
        }
        
        else if (cleanMsg.startsWith('move file')) {
            const parts = cleanMsg.replace('move file', '').split(' to ');
            if (parts.length === 2) {
                const fileName = parts[0].trim();
                const folderName = parts[1].trim();
                const fileToMove = await File.findOne({ owner: userId, originalName: { $regex: new RegExp(`^${fileName}$`, 'i') }, deletedAt: null });
                const targetFolder = await File.findOne({ owner: userId, originalName: { $regex: new RegExp(`^${folderName}$`, 'i') }, isFolder: true, deletedAt: null });
                if (!fileToMove) responseText = `File "${fileName}" not found.`;
                else if (!targetFolder) responseText = `Folder "${folderName}" not found.`;
                else {
                    fileToMove.parentId = targetFolder._id;
                    await fileToMove.save();
                    responseText = `Moved "${fileName}" to "${folderName}".`;
                }
            }
        }
        
        else if (cleanMsg.startsWith('delete file') || cleanMsg.startsWith('trash file')) {
            const fileName = cleanMsg.replace(/^(delete|trash) file/, '').trim();
            const file = await File.findOneAndUpdate({ owner: userId, originalName: { $regex: new RegExp(`^${fileName}$`, 'i') }, deletedAt: null }, { deletedAt: new Date() });
            responseText = file ? `Moved "${fileName}" to trash.` : `File "${fileName}" not found.`;
        }
        
        else if (cleanMsg.includes(' tag ')) {
            const addMatch = cleanMsg.match(/add tag (.+?) to (.+)/);
            const removeMatch = cleanMsg.match(/remove tag (.+?) from (.+)/);
            if(addMatch) {
                const file = await File.findOneAndUpdate({ owner: userId, originalName: { $regex: new RegExp(`^${addMatch[2].trim()}$`, 'i') }, deletedAt: null }, { $addToSet: { tags: addMatch[1].trim() } });
                responseText = file ? `Added tag to "${file.originalName}".` : `File not found.`;
            } else if (removeMatch) {
                const file = await File.findOneAndUpdate({ owner: userId, originalName: { $regex: new RegExp(`^${removeMatch[2].trim()}$`, 'i') }, deletedAt: null }, { $pull: { tags: removeMatch[1].trim() } });
                responseText = file ? `Removed tag from "${file.originalName}".` : `File not found.`;
            }
        }
        
        else if (cleanMsg.startsWith('protect ')) {
            const match = cleanMsg.match(/protect (.+?) with password (.+)/);
            if (match) {
                const file = await File.findOne({ owner: userId, originalName: { $regex: new RegExp(`^${match[1].trim()}$`, 'i') }, deletedAt: null });
                if (!file) responseText = `File not found.`;
                else {
                    file.password = await bcrypt.hash(match[2].trim(), 10);
                    await file.save();
                    responseText = `"${file.originalName}" is now password protected.`;
                }
            }
        }
        
        else if (cleanMsg.startsWith('create folder')) {
            const folderName = cleanMsg.replace('create folder', '').trim();
            await new File({ originalName: folderName, customAlias: `folder_${Date.now()}`, contentType: 'application/vnd.google-apps.folder', size: 0, owner: userId, isFolder: true }).save();
            responseText = `Folder "${folderName}" created.`;
        }
        
        else if (cleanMsg.startsWith('share ')) {
            const match = cleanMsg.match(/share (.+?) with (.+)/);
            if(match) {
                const file = await File.findOne({ owner: userId, originalName: { $regex: new RegExp(`^${match[1].trim()}$`, 'i') }, deletedAt: null });
                const targetUser = await User.findOne({ $or: [{ email: match[2].trim() }, { username: match[2].trim() }] });
                if(!file) responseText = `File not found.`;
                else if (!targetUser) responseText = `User not found.`;
                else {
                    await File.updateOne({ _id: file._id }, { $addToSet: { collaborators: targetUser._id } });
                    responseText = `Shared "${file.originalName}" with ${targetUser.username}.`;
                }
            }
        }

        else if (cleanMsg.startsWith('add user')) {
            const match = cleanMsg.match(/add user (.+?) to the (.+?) team/);
            if(match) {
                const team = await Team.findOne({ name: { $regex: new RegExp(`^${match[2].trim()}$`, 'i') }, members: userId });
                const userToAdd = await User.findOne({ username: match[1].trim() });
                if(!team) responseText = `Team not found or you're not a member.`;
                else if (!userToAdd) responseText = `User not found.`;
                else {
                    await Team.updateOne({ _id: team._id }, { $addToSet: { members: userToAdd._id } });
                    await User.updateOne({ _id: userToAdd._id }, { $addToSet: { teams: team._id } });
                    responseText = `Added ${userToAdd.username} to the ${team.name} team.`;
                }
            }
        }

        else if (cleanMsg.includes('generate a file request link')) {
            const label = cleanMsg.replace('generate a file request link for', '').trim();
            const slug = Math.random().toString(36).substring(2, 10);
            const reqFile = new FileRequest({ owner: userId, slug, label });
            await reqFile.save();
            const link = `${req.protocol}://${req.get('host')}/req/${slug}`;
            responseText = `File request link for "${label}" created: ${link}`;
            action = { type: 'copy', text: link };
        }
        
        else if (cleanMsg.includes('empty my trash')) {
            await File.deleteMany({ owner: userId, deletedAt: { $ne: null } });
            responseText = "Your trash bin has been emptied.";
        }
        
        else if (cleanMsg.includes('who am i')) { responseText = `Hello **${(await getUserProfile(userId)).username}**!`; }
        else if (cleanMsg.includes('storage')) { const s = await getStorageStats(userId); responseText = `Used: **${s.used}** of **${s.limit}**`; }
        else if (cleanMsg.includes('activity')) { responseText = `**Recent Activity:**\n${await getActivityLog(userId)}`; }
        else if (cleanMsg.includes('team')) { responseText = `**Team Info:**\n${await getTeamData(userId)}`; }
        else if (cleanMsg.startsWith('search user')) { responseText = `**Search Results:**\n${await searchUsers(cleanMsg.replace('search user', '').trim(), userRole)}`; }
        else if (cleanMsg.startsWith('read file')) { const f = await File.findOne({ owner: userId, originalName: { $regex: cleanMsg.replace('read file', '').trim(), $options: 'i' } }); responseText = f ? `**${f.originalName}**:\n${(await extractContent(f)).substring(0, 500)}...` : 'File not found.'; }
        else if (cleanMsg.startsWith('summarize')) { const f = await File.findOne({ owner: userId, originalName: { $regex: cleanMsg.replace('summarize', '').trim(), $options: 'i' } }); responseText = f ? `**Summary:**\n${summarizeText(await extractContent(f))}` : 'File not found.'; }
        else if (cleanMsg.includes('go to')) { action = { type: 'navigate', url: cleanMsg.includes('settings') ? '/profile' : '/dashboard' }; responseText = "Navigating..."; }
        else if (cleanMsg.includes('help')) { responseText = `**Available Actions:**\n- Rename/Move/Delete file\n- Create folder\n- Share file\n- Empty trash\n- Find/Search files\n- Ask natural questions about your workspace`; }
        else {
            if (isOpenRouterEnabled()) {
                try {
                    const [storageStats, recentFiles, workspaceIntel] = await Promise.all([
                        getStorageStats(userId),
                        File.find({ owner: userId, deletedAt: null })
                            .sort({ createdAt: -1 })
                            .limit(5)
                            .select('originalName contentType size createdAt isFolder')
                            .lean(),
                        getWorkspaceIntelligence(userId)
                    ]);

                    const openRouterReply = await requestOpenRouterReply({
                        message,
                        history,
                        user: req.user,
                        context,
                        storageStats,
                        recentFiles,
                        workspaceIntel,
                        schemaMap: AI_SCHEMA_MAP
                    });

                    if (openRouterReply?.response) {
                        responseText = openRouterReply.response;
                        action = openRouterReply.action || null;
                        usedOpenRouterReply = true;

                        const finalResponse = maskPII(responseText);
                        const log = new AiLog({ user: userId, query: message, response: finalResponse, ip: req.ip });
                        await log.save();

                        return res.json({
                            response: finalResponse,
                            action,
                            logId: log._id,
                            provider: 'openrouter',
                            model: openRouterReply.model,
                            usage: openRouterReply.usage,
                            assistantMessage: openRouterReply.assistantMessage
                        });
                    }
                } catch (codexError) {
                    console.error('OpenRouter Web AI Error:', codexError.message);
                }
            }

            if (!responseText) {
                responseText = `I'm sorry, I don't understand that command. Try "help" for a list of actions.`;
            }
        }

        const finalResponse = usedOpenRouterReply
            ? responseText
            : await translateText(responseText, userLang, 'en');
        const maskedResponse = maskPII(finalResponse);

        const log = new AiLog({ user: userId, query: message, response: maskedResponse, ip: req.ip });
        await log.save();

        res.json({ response: maskedResponse, action, logId: log._id });
    } catch (error) {
        console.error("AI Chat Error:", error);
        res.status(500).json({ response: "A system error occurred." });
    }
});

router.post('/feedback/:id', auth.protectApi, async (req, res) => {
    try {
        const { type } = req.body; 
        await AiLog.findByIdAndUpdate(req.params.id, { feedback: type });
        res.json({ message: 'Feedback received' });
    } catch (e) {
        res.status(500).json({ message: 'Error' });
    }
});

router.get('/insights', auth.protectApi, async (req, res) => {
    try {
        const pollMode = req.query.mode === 'poll';
        const query = { user: req.user.id };

        if (pollMode) {
            query.deliveredAt = null;
        }

        const insights = await AiInsight.find(query)
            .sort({ createdAt: -1 })
            .limit(pollMode ? 6 : 20)
            .lean();

        if (pollMode && insights.length > 0) {
            await AiInsight.updateMany(
                { _id: { $in: insights.map(item => item._id) } },
                { $set: { deliveredAt: new Date() } }
            );
        }

        res.json({
            insights: insights
                .reverse()
                .map(insight => ({
                    id: insight._id,
                    title: insight.title,
                    summary: insight.summary,
                    severity: insight.severity,
                    createdAt: insight.createdAt,
                    message: formatInsightMarkdown(insight),
                    metadata: insight.metadata || {}
                }))
        });
    } catch (error) {
        console.error('AI Insight Error:', error);
        res.status(500).json({ message: 'Failed to load AI insights.' });
    }
});

module.exports = router;
