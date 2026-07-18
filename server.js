require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ADZUNA_APP_ID = process.env.ADZUNA_APP_ID;
const ADZUNA_APP_KEY = process.env.ADZUNA_APP_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
console.log({
  adzunaID: !!ADZUNA_APP_ID,
  adzunaKey: !!ADZUNA_APP_KEY,
  anthropic: !!ANTHROPIC_API_KEY
});
// Maps our chip tags to search keywords Adzuna's job index understands.
// This is a starting point — tweak freely as you see what pulls in good results.
const KEYWORD_MAP = {
  gaming: 'gaming', art: 'art', sports: 'fitness', music: 'music', animals: 'pet',
  cooking: 'kitchen', writing: 'writing', tech: 'technology', fashion: 'retail',
  photography: 'photography', reading: 'bookstore', outdoors: 'outdoor',
  volunteering: 'nonprofit', cars: 'automotive', organizing: 'administrative',
  talking: 'customer service', patience: 'childcare', detail: 'clerical',
  'fast-learner': 'entry level', physical: 'warehouse', computers: 'IT support',
  creative: 'design', leadership: 'team lead', teamwork: 'team member', math: 'cashier',
  languages: 'bilingual', reliable: 'part time', handson: 'maintenance'
};

app.post('/api/match', async (req, res) => {
  try {
    const { age, zip, hobbies = [], skills = [], wage, hoursPerWeek } = req.body;

    if (!zip) {
      return res.status(400).json({ error: 'Zip code is required.' });
    }
    if (!ADZUNA_APP_ID || !ADZUNA_APP_KEY || !ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'Server is missing API keys. Check your .env file.' });
    }

    // Turn selected chips (plus any typed-in "custom:" entries) into search keywords
    const allTags = [...hobbies, ...skills];
    const keywords = allTags
      .map(t => (t.startsWith('custom:') ? t.replace('custom:', '') : KEYWORD_MAP[t] || t))
      .filter(Boolean);
    const searchTerm = [...new Set(keywords)].slice(0, 3).join(' ') || 'retail';

    // 1. Pull real, current listings from Adzuna
    let adzunaUrl =
      `https://api.adzuna.com/v1/api/jobs/us/search/1` +
      `?app_id=${ADZUNA_APP_ID}&app_key=${ADZUNA_APP_KEY}` +
      `&results_per_page=25&where=${encodeURIComponent(zip)}` +
      `&what=${encodeURIComponent(searchTerm)}&sort_by=relevance`;

    // A stated preference for under ~25 hrs/wk reads as part-time intent
    const hoursNum = parseFloat(hoursPerWeek);
    if (!isNaN(hoursNum)) {
      adzunaUrl += hoursNum <= 25 ? '&part_time=1' : '&full_time=1';
    }
    // Adzuna's salary filter is annual, so convert an hourly target roughly (hourly * 2080)
   // Salary filtering disabled for now because many entry-level jobs
// do not provide salary data in Adzuna.
console.log("Adzuna URL:", adzunaUrl);
    const adzunaRes = await fetch(adzunaUrl);
    if (!adzunaRes.ok) {
      throw new Error(`Adzuna request failed (${adzunaRes.status}). Double check your Adzuna keys and zip code.`);
    }
    const adzunaData = await adzunaRes.json();

    const jobs = (adzunaData.results || []).map(j => ({
      title: j.title?.replace(/<[^>]*>/g, '') || 'Untitled role',
      company: j.company?.display_name || 'Unknown company',
      location: j.location?.display_name || '',
      address: j.location?.display_name || (Array.isArray(j.location?.area) ? j.location.area.join(', ') : null) || 'Address not listed',
      salary_min: j.salary_min || null,
      salary_max: j.salary_max || null,
      contract_time: j.contract_time || null,
      description: (j.description || '').replace(/<[^>]*>/g, '').slice(0, 500),
      url: j.redirect_url
    }));

    if (jobs.length === 0) {
      return res.json({ matches: [] });
    }

    // 2. Ask Claude to pick the 10 best-fitting jobs and explain why, in the user's own terms
    const jobListText = jobs
      .map((j, i) => {
        const pay = j.salary_min
          ? `Pay: $${Math.round(j.salary_min)}${j.salary_max ? '–' + Math.round(j.salary_max) : ''}/yr`
          : 'Pay not listed';
        return `${i + 1}. "${j.title}" at ${j.company} — ${j.address}. ${j.contract_time || 'schedule not listed'}. ${pay}. ${j.description}`;
      })
      .join('\n');

    const prompt = `A person is looking for a job. Their profile:
- Age: ${age || 'not given'}
- Hobbies: ${hobbies.join(', ') || 'none listed'}
- Skills: ${skills.join(', ') || 'none listed'}
- Hoping to make: ${wage ? '$' + wage + '/hr' : 'no preference given'}
- Wants to work: ${hoursPerWeek ? hoursPerWeek + ' hrs/week' : 'no preference given'}

Here are real, currently open job listings near them:
${jobListText}

Work through this carefully rather than pattern-matching on job titles alone:

1. First, for EACH job, identify the specific day-to-day tasks and requirements
   implied by its title and description.
2. Then compare those tasks/requirements against the person's actual hobbies and
   skills one by one, noting genuine overlaps (including indirect or transferable
   ones — e.g. "patience" transfers to childcare or retail, "tech" transfers to
   any role involving computers or troubleshooting).
3. Weigh how many of the person's traits actually matter for that specific job,
   not just how many appear somewhere in the text.
4. Also weigh how well the job's pay and hours (where listed) line up with what
   they said they're hoping for — a job that pays noticeably below their target,
   or requires far more or fewer hours than they want, should score lower even
   if the skills/interests overlap is strong. If pay or hours aren't listed for
   a job, don't penalize it for that — just note the uncertainty in your reason.
5. Only after that analysis, assign each job a matchScore (0-100) that reflects
   the genuine overall strength of fit, and write a reason that cites the
   specific hobbies/skills/pay/hours that drove the score.

Do this reasoning for every job in the list before finalizing scores, so the
ranking reflects real comparison rather than a quick guess. Then pick the 10
best-fitting jobs and rank them best-fit first.

Respond with ONLY a JSON array as your final output, no markdown formatting and
no extra text, like:
[{"index": 3, "matchScore": 92, "reason": "..."}, {"index": 7, "matchScore": 85, "reason": "..."}]
"index" refers to the 1-based number of the job in the list above.`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
       model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        thinking: { type: 'enabled', budget_tokens: 3000 },
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      throw new Error(`Claude API request failed (${claudeRes.status}): ${errText}`);
    }

    const claudeData = await claudeRes.json();
    const rawText = (claudeData.content || []).map(b => b.text || '').join('');
    const cleaned = rawText.replace(/```json|```/g, '').trim();

    let ranked = [];
    try {
      ranked = JSON.parse(cleaned);
    } catch (e) {
      console.error('Could not parse Claude response as JSON:', rawText);
    }

    const matches = ranked
      .map(r => {
        const job = jobs[r.index - 1];
        if (!job) return null;
        return { ...job, matchScore: r.matchScore, reason: r.reason };
      })
      .filter(Boolean);

    res.json({ matches });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => {
  res.send('Job matcher backend is running. POST profile data to /api/match.');
});

app.listen(PORT, () => {
  console.log(`Job matcher backend running at http://localhost:${PORT}`);
});