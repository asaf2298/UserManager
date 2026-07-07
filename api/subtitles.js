import fetch from 'node-fetch';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const urlParts = req.url.split('?')[0].split('/');
        const subIdx = urlParts.indexOf('subtitles');
        if (subIdx < 1 || subIdx + 2 >= urlParts.length) {
            return res.status(400).json({ subtitles: [] });
        }

        const type = urlParts[subIdx + 1];
        const id = urlParts[subIdx + 2].replace('.json', '');
        
        const subtitleUrls = (process.env.SUBTITLE_URLS || '').split(',').map(u => u.trim()).filter(Boolean);
        if (subtitleUrls.length === 0) return res.status(200).json({ subtitles: [] });

        const requests = subtitleUrls.map(url => 
            fetch(`${url.replace(/\/$/, '')}/subtitles/${type}/${id}.json`)
                .then(r => r.json())
                .catch(() => ({ subtitles: [] }))
        );

        const results = await Promise.allSettled(requests);
        let allSubs = [];
        for (const r of results) {
            if (r.status === 'fulfilled' && r.value && Array.isArray(r.value.subtitles)) {
                allSubs = allSubs.concat(r.value.subtitles);
            }
        }
        
        // Deduplication based on ID AND Language
        const uniqueSubsMap = new Map();
        for (const sub of allSubs) {
            const lang = (sub.lang || '').toLowerCase();
            const key = `${sub.id}_${lang}`;
            if (!uniqueSubsMap.has(key)) {
                uniqueSubsMap.set(key, sub);
            }
        }
        let uniqueSubs = Array.from(uniqueSubsMap.values());

        // Sort: Hebrew first
        uniqueSubs.sort((a, b) => {
            const langA = (a.lang || '').toLowerCase();
            const langB = (b.lang || '').toLowerCase();
            const isHebA = langA.includes('hebrew') || langA.includes('heb');
            const isHebB = langB.includes('hebrew') || langB.includes('heb');
            
            if (isHebA && !isHebB) return -1;
            if (!isHebA && isHebB) return 1;
            return 0;
        });

        return res.status(200).json({ subtitles: uniqueSubs });

    } catch (error) {
        console.error('Subtitle Proxy Error:', error);
        return res.status(500).json({ subtitles: [] });
    }
}
