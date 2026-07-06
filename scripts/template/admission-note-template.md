# NTUH Admission Note Template & Rules

> `admission-note-filler` 產出入院紀錄時所依循的輸出模板與撰寫規則。
> 這份是「產出模板 / 規則」，與 [Primary Note 格式範本](./primary-note-format.md)（輸入格式）性質不同。

## GENERAL RULES
- Do NOT add information not present in the summary
- If information is not mentioned, write "not documented"
- Never abbreviate diagnosis names
- Output the full note first, then ITEMS TO VERIFY at the end

---

## PRESENT ILLNESS — 3 paragraphs

**Paragraph 1:** Patient background + symptom course up to ED referral  
**Paragraph 2:** ED evaluation — vital signs, PE findings, labs, imaging  
**Paragraph 3:** Diagnosis, initial management, admission reason

---

## REVIEW OF SYSTEMS (ROS)

- Change relevant items to (+) based on the summary
- Format: `symptom(+, brief description)` e.g. `cough(+, productive, for 1 week)`
- Keep all other items as (-)

---

## PHYSICAL EXAMINATION (PE)

- Fill in abnormal findings based on the summary
- Keep normal findings as per template default

---

## DIAGNOSIS FORMATTING

**Format:**
`[Full diagnosis name] ([modifier]), [status post Full Procedure Name on DATE] / [under medication (DATE-)]`

**Rules:**
- Never abbreviate diagnosis names
- `status post` = previously completed treatment/procedure
- `under` = currently ongoing treatment
- Do NOT write "(long-term)" — just write `under [medication]`
- If two active diagnoses share the same treatment, write separately under each
- Active diagnoses: primary admission diagnosis first
- Underlying diagnoses: most relevant to current admission first
- Measurements/scales: most recent value only, with date
  - e.g. `Heart failure with preserved ejection fraction, EF = 80.5% (2026/05/11)`
- Procedures: full name, with date
  - e.g. `status post Transurethral Resection of the Prostate on 2024/08/04`
- If date unknown: leave as `(____/__/__)`

**Date precision:**
- Within 2 years → YYYY/MM/DD
- 2–10 years ago → YYYY/MM
- More than 10 years ago → YYYY

---

## PLAN

- Maximum 5 items
- Order by priority
- Consolidate related items
- Be concise — one line per item where possible, no sub-bullets

---

## ITEMS TO VERIFY

At the end of every output, add:

```
===ITEMS TO VERIFY===
[ ] [Section] - [issue] → [action needed]
```

Include:
- Missing dates (surgery, procedures, measurements) → marked as `(____/__/__)`
- Missing medication dosages
- Symptoms unconfirmable due to cognitive status
- Pending lab/culture results
- Anything marked "not documented"

---

## OUTPUT TEMPLATE

```
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
#. [max 5 items, ordered by priority, one line each]

===ITEMS TO VERIFY===
[ ] [Section] - [issue] → [action needed]
```
