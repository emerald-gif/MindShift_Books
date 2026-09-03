// public/article-categories.js
// Single source of truth for MindShift Books' content categories.
// Used by: onboarding (interest picker), write.html (category picker),
// articles.html (filter pills + "For You" personalization), profile.html
// (author's published-article breakdown).
//
// `code` is what gets stored on articles.cat and users.categories[] —
// never rename a code after articles exist with it, or old content
// silently falls out of every filter/personalization path that reads it.
// Add new codes freely; retire old ones by removing them from PICKS only
// (leave them in ALL_CODES-adjacent article data alone).

window.MSB_CATEGORIES = [
  { code: 'MINDSET',      label: 'Mindset & Personal Development', emoji: '🧠',
    sub: ['Self-Improvement','Confidence & Self-Esteem','Personal Growth','Self-Discipline','Positive Thinking','Emotional Intelligence','Self-Awareness','Overcoming Limiting Beliefs','Resilience','Life Skills'] },
  { code: 'MONEY',        label: 'Money & Financial Growth', emoji: '💰',
    sub: ['Personal Finance','Saving & Budgeting','Investing','Wealth Building','Financial Mindset','Entrepreneurship','Business','Career & Income','Financial Independence'] },
  { code: 'PRODUCTIVITY', label: 'Productivity & Success', emoji: '🎯',
    sub: ['Productivity','Goal Setting','Time Management','Habits','Focus & Concentration','Procrastination','Leadership','Success Principles','Performance','Decision Making'] },
  { code: 'RELATIONSHIPS',label: 'Relationships & Emotional Wellbeing', emoji: '❤️',
    sub: ['Relationships','Dating & Love','Marriage','Friendship','Communication','Emotional Wellbeing','Overthinking','Stress Management','Personal Boundaries','Healing & Self-Discovery'] },
  { code: 'HEALTH',       label: 'Health, Wellness & Lifestyle', emoji: '🌱',
    sub: ['Healthy Living','Sleep','Fitness','Nutrition','Mental Wellness','Stress','Lifestyle Design','Self-Care','Work-Life Balance'] },
  { code: 'CAREER',       label: 'Career, Leadership & Entrepreneurship', emoji: '🚀',
    sub: ['Career Development','Job Searching','Professional Growth','Leadership','Entrepreneurship','Freelancing','Small Business','Management','Workplace Skills','Networking'] },
  { code: 'EDUCATION',    label: 'Education & Learning', emoji: '📚',
    sub: ['Study Skills','Learning Strategies','Academic Success','Exam Preparation','Communication Skills','Critical Thinking','Personal Knowledge','Language Learning','Teaching & Education'] },
  { code: 'PURPOSE',      label: 'Purpose, Spirituality & Life', emoji: '🌍',
    sub: ['Purpose','Meaning','Faith & Spiritual Growth','Philosophy','Reflection','Identity','Life Lessons','Personal Values','Finding Direction'] },
  { code: 'REFLECTIVE',   label: 'Inspirational & Reflective Writing', emoji: '✍️',
    sub: ['Inspirational','Memoirs','Life Stories','Essays','Poetry','Reflections','Motivational Writing'] },
  { code: 'FICTION',      label: 'Fiction With Meaning', emoji: '📖',
    sub: ['Inspirational Fiction','Contemporary Fiction','Literary Fiction','Romance','Young Adult','Short Stories','Coming-of-Age','Social/Contemporary Issues'] },
];

// Lookup helpers
window.MSB_CAT_BY_CODE = window.MSB_CATEGORIES.reduce((m, c) => { m[c.code] = c; return m; }, {});
window.msbCatLabel = function (code) {
  const c = window.MSB_CAT_BY_CODE[code];
  return c ? c.label : (code || '');
};
