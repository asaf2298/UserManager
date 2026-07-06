import fetch from 'node-fetch';

export default async function handler(req, res) {
    const urlParts = req.url.split('?')[0].split('/');
    const subtitleIdx = urlParts.indexOf('subtitles');
    if (subtitleIdx < 1) return res.status(400).json({ subtitles: [] });

    const type = urlParts[subtitleIdx + 1];
    const id = urlParts[subtitleIdx + 2].replace('.json', '');
    
    const subtitleUrls = (process.env.SUBTITLE_URLS || '').split(',').map(u => u.trim());
    
    const requests = subtitleUrls.map(url => 
        fetch(`${url}/subtitles/${type}/${id}.json`)
            .then(r => r.json())
            .catch(() => ({ subtitles: [] }))
    );

    const results = await Promise.allSettled(requests);
    let allSubs = [];
    results.forEach(r => {
        if (r.status === 'fulfilled' && r.value.subtitles) {
            allSubs = [...allSubs, ...r.value.subtitles];
        }
    });

    // ניקוי כפילויות וסידור: עברית ראשונה
    const uniqueSubs = Array.from(new Map(allSubs.map(s => [s.id, s])).values());
    uniqueSubs.sort((a, b) => {
        const langA = (a.lang || '').toLowerCase();
        const langB = (b.lang || '').toLowerCase();
        if (langA.includes('hebrew') || langA === 'heb') return -1;
        if (langB.includes('hebrew') || langB === 'heb') return 1;
        return 0;
    });

    return res.status(200).json({ subtitles: uniqueSubs });
}
