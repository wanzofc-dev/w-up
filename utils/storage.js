const File = require('../models/file');
const User = require('../models/user');

async function getUserStorageSnapshot(userId) {
    const [user, stats] = await Promise.all([
        User.findById(userId).select('storageLimit storageBonus storageUsed'),
        File.aggregate([
            {
                $match: {
                    owner: userId,
                    deletedAt: null,
                    isFolder: { $ne: true }
                }
            },
            {
                $group: {
                    _id: null,
                    totalSize: { $sum: { $max: ['$size', 0] } },
                    totalFiles: { $sum: 1 }
                }
            }
        ])
    ]);

    const used = Number(stats?.[0]?.totalSize || 0);
    const fileCount = Number(stats?.[0]?.totalFiles || 0);
    const baseLimit = Number(user?.storageLimit || 0);
    const bonus = Number(user?.storageBonus || 0);
    const total = baseLimit + bonus;
    const available = Math.max(0, total - used);
    const percentage = total > 0 ? Math.min(100, (used / total) * 100) : 0;

    if (user && Number(user.storageUsed || 0) !== used) {
        await User.updateOne({ _id: userId }, { $set: { storageUsed: used } });
    }

    return {
        used,
        total,
        available,
        percentage,
        fileCount,
        bonus,
        baseLimit
    };
}

module.exports = {
    getUserStorageSnapshot
};
