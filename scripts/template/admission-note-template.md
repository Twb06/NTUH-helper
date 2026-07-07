# NTUH Admission Note Template & Rules

> `admission-note-filler` 產出入院紀錄時所依循的輸出模板與撰寫規則。
> 這份是「產出模板 / 規則」，與 [Primary Note 格式範本](./primary-note-format.md)（輸入格式）性質不同。

## GENERAL RULES
- Do NOT add information not present in the summary
- If information is not mentioned, write "not documented"
- Never abbreviate diagnosis names
- Never include ICD or any diagnosis codes
- Output the full note first, then ITEMS TO VERIFY at the end
- Do not add extra blank lines; follow the spacing in the template exactly
- If a section has no content (e.g. `[Image] = not documented`), still include the header but keep it to one line

---

## PRESENT ILLNESS — 3 paragraphs

**Determine admission route first:**
- **Via ED:** evaluated in ED before admission
- **Via OPD:** admitted directly through outpatient clinic

**Paragraph 1 — Background + symptom course**
- Via ED: end with `...referred to our emergency department (ED).`
- Via OPD: end with `...He/She then went to Dr. [name]'s OPD for help on [date].`

**Paragraph 2 — Evaluation findings**
- Via ED: vital signs → PE → labs → imaging
- Via OPD: `At the out-patient clinic, [findings]...`
- Labs: highlight only abnormal or clinically relevant values with number in parentheses
  - e.g. `leukocytosis (WBC 18.3 K/μL)`; group normal results as `...were unremarkable`
- Imaging: interpreted finding with key descriptor, not raw report

**Paragraph 3 — Diagnosis + management + admission reason**
- Via ED: `[Diagnosis] was diagnosed. Initial management included [types]. Admitted for [diagnosis].`
- Via OPD: `...admission was arranged for further evaluation and management. So this time, under the diagnosis of [diagnosis], he/she was admitted for [reason].`

---

## REVIEW OF SYSTEMS (ROS)

- Mark positive findings as: `symptom(+, brief description)`
  - e.g. `cough(+, productive, for 1 week)`
- All other items remain (-)

---

## PHYSICAL EXAMINATION (PE)

- Default neuro exam: `clear and oriented` / `full` / `steady`
- Override only if abnormality is documented in summary
- Fill in abnormal findings; keep normal findings as per template

---

## DIAGNOSIS FORMATTING

**Format:**
`[Full diagnosis name] ([modifier]), [status post Full Procedure Name on DATE], [under medication]`

**Rules:**
- No diagnosis abbreviations; no ICD codes
- `status post` = completed; `under` = ongoing
- Medications: no dates, no "(long-term)" — just `under [medication]`
- Multiple medications: comma-separated e.g. `under Losartan, Bisoprolol`
- Same treatment shared by two diagnoses → write separately under each
- Measurements/scales: most recent value only + date
  - e.g. `EF = 80.5% (2026/05/11)`, `MMSE = 3 (2024)`
- Procedures: full name + date
  - e.g. `status post Transurethral Resection of the Prostate on 2024/08/04`
- Unknown date → `(____/__/__)`

**Date precision:**
- ≤2 years → YYYY/MM/DD
- 2–10 years → YYYY/MM
- >10 years → YYYY

**Ordering:**
- Active: primary admission diagnosis first; conditions most directly impacting current care (e.g. malnutrition, sepsis) take priority over the underlying cause
- Underlying: most relevant to current admission first

**Antibiotic / treatment history under a diagnosis:**
- List as indented sub-items in chronological order
- Completed courses: `- status post [drug] from YYYY/MM/DD to YYYY/MM/DD`
- Ongoing: `- under [drug]` — always last in the list
- Do NOT write ongoing treatment inline after the diagnosis name if there is a treatment history; use sub-items instead

**Chemotherapy notation:**
- Include C1D1 and the most recent cycle's D1
- Format: `status post [Regimen] (C1D1=YYYY/MM/DD, CxD1=YYYY/MM/DD)`
- If still ongoing, write as sub-item: `- status post [Regimen] (C1D1=..., CxD1=...)`

**Oncology diagnoses:**
- Include staging e.g. `(pT4aN1bM1c, stage IVc)`
- Include molecular markers if documented e.g. `Her2/Neu 0/3+; KRAS c.35G>T, p.G12V, wild B-raf, pMMR`
- If markers not in summary, add to ITEMS TO VERIFY

---

## PLAN

- Group by active diagnosis as primary structure
- Sub-header = diagnosis name in brackets
- Append `[Disposition]` and `[Future plans]` at end
- Omit sub-headers with no content
- One line per item; abbreviate freely: abx, f/u, c/w, w/, s/p, IR, OPD
- Cut filler words

---

## ITEMS TO VERIFY

At the end of every output, add:

```
===ITEMS TO VERIFY===
[ ] [Section] - [issue] → [action needed]
```

Include:
- Missing dates for procedures/measurements → `(____/__/__)`
- Missing medication dosages
- Symptoms unconfirmable due to cognitive status
- Pending lab/culture results
- Anything marked "not documented"

---

## OUTPUT TEMPLATE

```
主訴 (Chief Complaint)
Informant: patient, family and medical records
CC: [chief complaint in one line]

病史(Patient History)
【Present illness】
This is a [age]-year-old [male/female] with the medical history of
#. [past medical history 1]
#. [past medical history 2]

The patient was in his/her usual state of health until [date/period],
when [symptom onset and course]. The patient was brought to
[clinic/ED] on [date], and was subsequently referred to our
emergency department (ED).

Upon arrival, vital signs were: T: [°C], HR: [bpm], RR: [/min],
BP: [mmHg], SpO₂: [%] under [ambient air / O2 device]. Physical
examination revealed [abnormal findings, or "no significant
abnormality"]. Laboratory workup showed [key lab findings].
Imaging showed [key imaging findings].

[Diagnosis] was diagnosed. Initial management included [medication
types]. The patient was admitted to our ward for further treatment
of [final diagnosis].

【Past History】
1. Family history: CAD(-), DM(-), HTN(-), CVD(-), Cancer(-)
2. Allergy
   - Medication allergy, ADR, or Allergy to Device and Materials:
3. Current medication
   - NTUH:
   - Other: nil
   - 中草藥: nil
   - 保健食品: nil
4. TOCC
   - Travel: nil
   - Occupation:
   - Contact: nil
   - Cluster: nil
5. Habits:
   - Alcohol: nil
   - Betel nuts: nil
   - Cigarette: nil

系統性回顧(Review of Systems)
1. Systemic: weight loss(-), easy-fatigability(-), night sweats(-)
2. Skin: petechiae(-), purpurae(-), skin rash(-), itching(-)
3. HEENT: headache(-), dizziness(-), blurred vision(-),
   strabismus(-), ocular pain(-), otalgia(-), otorrhea(-),
   hearing impairment(-), tinnitus(-), vertigo(-), nasal
   stuffiness(-), nasal discharge(-), epistaxis(-), gum
   bleeding(-), sore throat(-), oral ulcer(-)
4. Cardiovascular: exertional chest tightness(-), nocturnal
   dyspnea(-), orthopnea(-), syncope(-), palpitation(-),
   intermittent claudication(-)
5. Respiratory: dyspnea(-), cough(-), chest pain(-), hemoptysis(-),
   productive cough(-), pleuritic chest pain(-)
6. Gastrointestinal: anorexia(-), nausea(-), vomiting(-),
   dysphagia(-), heartburn(-), acid regurgitation(-), abdominal
   fullness(-), hunger pain(-), midnight pain(-), constipation(-),
   diarrhea(-), melena(-), change of bowel habit(-), small caliber
   of stool(-), tenesmus(-), flatulence(-)
7. Urogenital: flank pain(-), hematuria(-), urinary frequency(-),
   urgency(-), dysuria(-), hesitancy(-), small stream of urine(-),
   impotence(-), nocturia(-), polyuria(-), oliguria(-),
   incontinence(-)
8. Musculoskeletal: bone pain(-), arthralgia(-), myalgia(-),
   weakness(-), back pain(-)
9. Metabolic: heat intolerance(-), cold intolerance(-), thirsty(-)
10. Nervous: numbness(-), paresis/plegia(-)

身體診察(Physical Examination)
Neurological Examination:
. Consciousness: [fill in]
. Muscle power: [fill in]
. Gait: [fill in]
1. HEENT: Generally normal
2. Eyes: Conjunctivae: not pale; Sclerae: anicteric
   Pupils: isocoric; Light reflexes: R/L: +/+;
   Extraocular movement: full and free
3. Neck: supple; no jugular vein engorgement; no palpable lymph node
4. Chest: symmetric expansion; [breathing sound]; [crackles/wheeze]
5. Heart: regular heart beats; no murmur
6. Abdomen: flat; normoactive bowel sounds; soft; no tenderness;
   no rebound tenderness; liver/spleen: impalpable
7. Back: no CV angle knocking tenderness
8. Extremities: freely movable; no pitting edema
9. Skin: Abnormal pigmentation(-), skin rash(-), Petechiae(-)
   Purpura(-) Ecchymoses(-) Telangiectasia(-), Plaque(-),
   Lymphadenopathy(-)

臆斷(Tentative Diagnosis)
[Active]
#. [primary diagnosis]
#. [secondary active diagnosis]

[Underlying]
#. [chronic condition 1, most relevant to admission first]
#. [chronic condition 2]

醫療需求與治療計畫(Medical Needs and Care Plan)
=========Subjective=========
CC: [chief complaint in one line]

=========Assessment=========
[PE]
1. [key PE finding 1]
2. [key PE finding 2]

[Lab]
[key lab findings, format: test: value (H/L/normal)]

[CXR]
[CXR finding]

[EKG]
[EKG finding, or "not documented"]

[Image]
[Other imaging findings not covered by CXR, e.g. ultrasound, CT, MRI, or "not documented"]

[Other examination]
[Other examinations not covered above, e.g. endoscopy, spirometry, or "not documented"]

=========Diagnosis=========
[Active]
#. [primary diagnosis]
#. [secondary active diagnosis]

[Underlying]
#. [chronic condition 1, most relevant to admission first]
#. [chronic condition 2]

==========Plan=============
[Active Diagnosis 1]
#. ...

[Active Diagnosis 2]
#. ...

[Disposition]
#. ...

[Future plans]
#. ...

===ITEMS TO VERIFY===
[ ] [Section] - [issue] → [action needed]
```
