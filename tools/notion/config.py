"""
Notion workspace configuration — page IDs, grade mappings, subject aliases.
All IDs sourced from the live Notion workspace scan.
"""

# Grade root page IDs
GRADE_PAGES = {
    5:  "2c1998381c7680a49fe0cedb1aac47f4",
    6:  "2c1998381c768073865dc997614f4db4",
    7:  "2c1998381c768067a3efe250628d4994",
    8:  "2c1998381c768041bed1ee49a6d59e29",
    9:  "2c1998381c768097890ed6fc9c99911a",
    10: "2c1998381c76800187a1eadf696912f7",
    11: "2c1998381c76804381fccd23858b28bb",
}

# Language page IDs (grade -> {lang: page_id})
LANGUAGE_PAGES = {
    5:  {"uz": "2c8998381c768026ba72c2cf82588d2a", "ru": "2c8998381c7680138654f497c3931e60"},
    6:  {"uz": "2c8998381c7680978e85d30d6f86ba2c", "ru": "2c8998381c7680faada5f29636896362"},
    7:  {"uz": "2c8998381c7680e394bbe1df3997cf02", "ru": "2c8998381c768048807de4a91d58608c"},
    8:  {"uz": "2c8998381c768062b478ca09bf03c0b9", "ru": "2c8998381c768040a3cfcb05b6527671"},
    9:  {"uz": "2c8998381c7680f08ccbcb95821f1015", "ru": "2c8998381c7680a7afa0ef78488a51cf"},
    10: {"uz": "2c8998381c768043a4cced6b4a116178", "ru": "2c8998381c7680fc94b6c9baff8aaafb"},
    11: {"uz": "2c9998381c76805193f3d0c934261f95", "ru": "2c9998381c7680f1a06cf3a05161cea5"},
}

# Subjects to skip (no video lessons)
SKIP_SUBJECTS = [
    "jismoniy tarbiya",
    "физическая культура",
    "physical education",
    "jismoniy",
    "физкультура",
    "чбт",
    "chqbt",
    "нвп",
]

# Subject name aliases (canonical -> variations)
SUBJECT_ALIASES = {
    "tarix": ["tarix", "история", "history", "qadimgi dunyo", "qadimgi dunyo tarixi", "tarix (qadimgi dunyo)", "tarix qadimgi dunyo tarixi"],
    "jahon tarixi": ["jahon tarixi", "jahon", "всемирная история", "world history", "tarix (jahon tarixi)"],
    "o'zbekiston tarixi": ["o'zbekiston tarixi", "tarix uzb", "история узбекистана", "ozbekiston tarixi", "uzbekistan history"],
    "ona tili": ["ona tili", "родной язык", "ona tili va o'qish"],
    "matematika": ["matematika", "математика", "matematika 1-qism", "matematika 2-qism"],
    "algebra": ["algebra", "алгебра"],
    "geometriya": ["geometriya", "геометрия"],
    "biologiya": ["biologiya", "биология"],
    "fizika": ["fizika", "физика"],
    "kimyo": ["kimyo", "химия"],
    "geografiya": ["geografiya", "география"],
    "ingliz tili": ["ingliz tili", "английский язык", "english"],
    "rus tili": ["rus tili", "русский язык"],
    "adabiyot": ["adabiyot", "литература", "adabiyot 1-qism", "adabiyot 2-qism"],
    "informatika": ["informatika", "информатика", "dasturlash"],
    "musiqa": ["musiqa", "музыка"],
    "texnologiya": ["texnologiya", "технология"],
    "tasviriy san'at": ["tasviriy san'at", "изобразительное искусство"],
    "huquq": ["huquq", "право"],
    "iqtisodiy bilim asoslari": ["iqtisodiy bilim asoslari", "экономика"],
    "chizmachilik": ["chizmachilik", "черчение"],
    "astronomiya": ["astronomiya", "астрономия"],
    "tadbirkorlik": ["tadbirkorlik", "предпринимательство"],
}

# Per-chapter sub-page structure
CHAPTER_SUBPAGES = [
    "Text Original",
    "Text Refined AI",
    "Video",
    "Images",
    "Audio",
    "Prompt",
    "Lesson files PPT, PDF",
    "Final Video",
    "Quizlet (Adrian)",
    "Homework",
    "Lesson Plan (Adrian)",
    "Get ready to start for Teachers (Adrian)",
]

# Grade-level context
GRADE_CONTEXT = {
    5:  {"age_range": "10-11", "level": "beginner", "subjects_count": 16},
    6:  {"age_range": "11-12", "level": "beginner", "subjects_count": 16},
    7:  {"age_range": "12-13", "level": "intermediate", "subjects_count": 19},
    8:  {"age_range": "13-14", "level": "intermediate", "subjects_count": 20},
    9:  {"age_range": "14-15", "level": "intermediate", "subjects_count": 20},
    10: {"age_range": "15-16", "level": "advanced", "subjects_count": 22},
    11: {"age_range": "16-17", "level": "advanced", "subjects_count": 22},
}

# History subject splitting
# Grades 5-6: single "Tarix" subject
# Grades 7-11: splits into "Jahon Tarixi" + "O'zbekiston Tarixi"
HISTORY_SPLIT_GRADE = 7

# Math splits too
MATH_SPLIT_GRADE = 7
