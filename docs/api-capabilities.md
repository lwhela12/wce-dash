# AdvancedMD API Capabilities — Complete Reference

## WCE Provider Intelligence Dashboard

---

## Two APIs, Two Purposes

| | FHIR R4 API | Connect API |
|---|---|---|
| **Purpose** | Clinical data interoperability | Practice management (PM) + EHR |
| **Access** | Free (ONC-mandated) | Paid (partner agreement required) |
| **Operations** | Read-only | Full CRUD |
| **Auth** | SMART on FHIR / JWT | Proprietary token + API key |
| **Best for** | Clinical data, diagnoses, procedures, medications, labs | Billing, scheduling, financial, A/R, claims |

---

# FHIR R4 API

## Authentication
- **Bulk API**: JWT assertion + provider credentials → `system/*.read` scope
- **Provider App**: SMART launch → `user/*.read` scope
- **Patient App**: SMART launch → `patient/*.read` scope

## Key Finding from Testing
**AdvancedMD puts CPT codes (E/M, debridement, surgical) in `Encounter.type`, not in `Procedure` resources.** Procedure resources may be empty. All billing/procedure code extraction must come from Encounter.

## Supported Resources (25 confirmed)

### Critical for Dashboard

| Resource | What It Contains | Search Params | Dashboard Use |
|---|---|---|---|
| **Encounter** | Visit type, **CPT codes in type** (E/M, debridement, surgical), period, practitioner, location, diagnoses | patient, date, status, class, type | E/M distribution, debridement rates, visit volume, patient volume per provider, new vs follow-up |
| **Condition** | ICD-10 diagnoses, clinical status (active/resolved), onset date, abatement date, body site | patient, category, clinical-status, code, onset-date | Wound diagnoses, Z51.89 closures, Z51.5 palliative, heal rates (onset→abatement), patients >16 weeks, diagnosis distribution |
| **Patient** | Demographics, identifiers, address, insurance | _id, name, family, given, birthdate, gender, identifier | Patient counts, demographics |
| **Practitioner** | Name, NPI, specialty, qualifications | name, identifier | Provider names, roles, specialties |
| **Coverage** | Insurance carrier, plan, beneficiary, payor, period | patient | Insurance breakdown, payor mix |
| **MedicationRequest** | Prescribed medications, requester, authoredOn, dosage | patient, status, intent, authoredon | Prescriptions written per provider |
| **ServiceRequest** | Orders and referrals (labs, imaging, specialty), category, code (SNOMED), requester, authoredOn | patient, status, category, code | ABI orders, venous/arterial US, lab/culture orders, endo/vascular/podiatry/hospice referrals, DME, radiology orders, 30-day timing |

### Important for Dashboard

| Resource | What It Contains | Dashboard Use |
|---|---|---|
| **Observation** | Wound measurements (area, depth), vital signs, lab results (HbA1c, albumin), LOINC codes | Wound healing trajectory, lab values |
| **DiagnosticReport** | Lab reports, culture results, imaging reports | Lab/culture counts |
| **Location** | Facility name, address | Facility list, multi-site reporting |
| **DocumentReference** | Clinical notes, wound photos, referral letters | Clinical documentation (if needed) |

### Supporting Resources

| Resource | What It Contains | Dashboard Use |
|---|---|---|
| **CarePlan** | Treatment plans (may be minimal/narrative only) | Care plan tracking (limited) |
| **CareTeam** | Provider-patient assignments | Care coordination |
| **Goal** | Treatment targets, due dates | Healing goals (limited) |
| **AllergyIntolerance** | Medication/substance allergies | Safety alerts |
| **Immunization** | Vaccination records | Tetanus status for wound patients |
| **MedicationDispense** | Actually dispensed medications | Dispensing tracking |
| **Device** | Implantable devices, DME with UDI | Device tracking |
| **Organization** | Practice, hospital, payor organizations | Organization data |
| **Specimen** | Wound culture/biopsy specimens | Specimen tracking |
| **RelatedPerson** | Family, caregivers | Contact info |
| **Provenance** | Audit trail (who modified what) | Compliance |
| **Endpoint** | Technical API endpoints | System config |
| **Group** | Patient cohorts for bulk export | Bulk export targeting |
| **Procedure** | **Likely empty in AdvancedMD** — CPT codes are in Encounter.type | Fallback only |

---

## Dashboard Metrics Mapped to FHIR

### Billing Patterns (per provider, compared across providers)

| Metric | FHIR Source | Confidence |
|---|---|---|
| Debridement rate (97597, 97598, 97602, 11042-11044) | Encounter.type CPT codes | HIGH |
| E/M code distribution (99211-99215, 99232-99233) | Encounter.type CPT codes | HIGH |
| Surgical procedure codes | Encounter.type CPT codes | HIGH |
| Compression codes ordered (A6530-A6549) | Encounter.type or ServiceRequest | MEDIUM — may be HCPCS billing-only |
| Z51.89 closure code | Condition.code | HIGH |
| MIST / ultrasonic debridement orders | Encounter.type or ServiceRequest | MEDIUM — depends on coding |

### Provider Outcomes

| Metric | FHIR Source | Confidence |
|---|---|---|
| Provider heal rates | Condition (onset → abatement dates) | HIGH — if abatement dates populated |
| Days to heal | Condition (onset → abatement dates) | HIGH — same dependency |
| Patients in treatment >16 weeks | Condition.onsetDateTime + clinicalStatus=active | HIGH |
| Number of palliative patients | Condition.code = Z51.5 | HIGH |

### Orders & Diagnostics

| Metric | FHIR Source | Confidence |
|---|---|---|
| ABI orders (total + within 30d of first visit) | ServiceRequest + Encounter dates | MEDIUM — depends on structured entry |
| Venous ultrasound orders (total + within 30d) | ServiceRequest | MEDIUM |
| Arterial ultrasound orders (total + within 30d) | ServiceRequest | MEDIUM |
| Labs ordered (total + within 30d of admission) | ServiceRequest (category=laboratory) | MEDIUM-HIGH |
| Cultures ordered (total + within 30d) | ServiceRequest | MEDIUM-HIGH |
| Endocrinology referrals (by diabetic ulcer codes) | ServiceRequest + Condition | MEDIUM |
| WCE Vascular referrals | ServiceRequest | MEDIUM |
| WCE Podiatry referrals | ServiceRequest | MEDIUM |
| Hospice referrals | ServiceRequest | MEDIUM |
| DME orders | ServiceRequest | MEDIUM |
| Radiology orders | ServiceRequest | MEDIUM |

### Patient Volume

| Metric | FHIR Source | Confidence |
|---|---|---|
| Patient volume per provider (weekly/monthly) | Encounter (date + practitioner) | HIGH |
| New patients per provider | Encounter (first visit logic) | HIGH |
| Follow-up patients per provider | Encounter (subsequent visits) | HIGH |
| Prescriptions written | MedicationRequest (requester + authoredOn) | HIGH |

### Population Data

| Metric | FHIR Source | Confidence |
|---|---|---|
| Active patients | Patient + Condition (active wounds) | HIGH |
| Insurance carrier breakdown | Coverage.payor | HIGH |
| Diagnosis distribution (ICD-10) | Condition.code | HIGH |
| Chronic conditions | Condition (comorbidities) | HIGH |

---

## What FHIR Cannot Provide

| Data Need | Why Not Available | Alternative |
|---|---|---|
| Revenue / charges / reimbursement amounts | Financial data not in provider-side FHIR | Connect API |
| Claim status (submitted/denied/paid) | Payer-side FHIR resource (ExplanationOfBenefit) | Connect API |
| No-show rates / cancellations | Scheduling data not in FHIR | Connect API |
| Appointment slots / scheduling | Not a FHIR read resource | Connect API |
| Referral sources (how patients found WCE) | Intake/marketing data | Connect API custom fields |
| Collections / A/R aging | Financial data | Connect API |
| Modifier codes on CPT (e.g., -59, -25) | May or may not be in Encounter.type | Needs testing |
| Wound photographs | May exist in DocumentReference but bandwidth/access uncertain | Needs testing |

---

# Connect API

## Authentication
- Proprietary token-based (API Key + Office Key + credentials → session token)
- NOT standard OAuth 2.0
- Requires AdvancedMD integration partner agreement

## Access Requirements
- **Commercial agreement** required (not self-service)
- **Per-practice licensing fees** (varies by scope/volume)
- **Email**: Contact through AdvancedMD website or partner program
- **Sandbox**: Provided with partner agreement

## Available Modules

### Scheduling

| Data | Operations | Dashboard Use |
|---|---|---|
| Appointments (search, create, update, cancel) | Full CRUD | No-show tracking, cancellation rates |
| Appointment types and reason codes | Read | Visit type analysis |
| Provider schedules/templates | Read | Availability analysis |
| Check-in/check-out times | Read | Wait time analysis |
| Confirmation status | Read/Update | Confirmation rate tracking |

### Billing / Claims

| Data | Operations | Dashboard Use |
|---|---|---|
| CPT/HCPCS codes with modifiers | Full CRUD | **Definitive billing code source** — includes modifiers and units |
| ICD-10 diagnosis codes (up to 12 pointers) | Read | Diagnosis verification |
| Charge amounts, allowed amounts, paid amounts | Read | Revenue per provider, per procedure |
| Claim status (submitted/accepted/denied/paid) | Read | Denial rates, clean claim rates |
| ERA/EOB data | Read | Reimbursement rates by payor |
| Denial reason codes | Read | Denial pattern analysis |
| Place of service, rendering/billing provider | Read | Multi-site billing analysis |

### Financial / Accounting

| Data | Operations | Dashboard Use |
|---|---|---|
| Account balances (patient and insurance) | Read | A/R tracking |
| Aging reports (0-30, 31-60, 61-90, 91-120, 120+) | Read | Collections aging |
| Transaction history | Read | Payment trends |
| Payment ledger (check/EFT numbers) | Read | Payment tracking |
| Collection status | Read | Collections pipeline |
| Financial summaries by provider, location, payer | Read | **Revenue dashboards** |
| Write-off and adjustment details | Read | Write-off analysis |

### Patient Demographics

| Data | Operations | Dashboard Use |
|---|---|---|
| Full demographics | Full CRUD | Patient management |
| Insurance policy details | Read/Update | Eligibility, payor analysis |
| Guarantor information | Read | Billing responsibility |
| Patient balance, last visit date | Read | Financial status |
| Custom field values | Read/Write | Practice-specific tracking |

### EHR / Clinical

| Data | Operations | Dashboard Use |
|---|---|---|
| Clinical documents | Read | Note retrieval |
| Encounter data | Read | Visit details |
| Vitals | Read | Clinical data |
| Allergies, medications, problem lists | Read | Clinical context |
| Lab orders and results | Read | Lab tracking |
| Referral management | Read | Referral tracking |

### Reference Data

| Data | Operations | Dashboard Use |
|---|---|---|
| Provider lists | Read | Provider directory |
| Facility/location lists | Read | Location management |
| Insurance carrier/plan lists | Read | Payor reference |
| CPT and ICD code lookups | Read | Code validation |
| Referring provider lists | Read | Referral source tracking |

---

## Dashboard Metrics — Connect API Only

| Metric | Connect API Module | FHIR Available? |
|---|---|---|
| Total charges (dollar amounts) | Billing | NO |
| Total reimbursed (dollar amounts) | Financial | NO |
| Revenue by insurance carrier | Financial | NO |
| Reimbursement rate by payor | Financial | NO |
| No-show count and rate | Scheduling | NO |
| No-shows by facility | Scheduling | NO |
| No-show top reasons | Scheduling (custom fields) | NO |
| Avg collections lag (days) | Financial | NO |
| Referral sources (how patients found practice) | Scheduling / Custom Fields | NO |
| CPT modifier codes (-59, -25, etc.) | Billing | MAYBE (in Encounter.type) |
| Charge amounts per CPT code | Billing | NO |
| Denial rates and reasons | Billing/Claims | NO |
| A/R aging buckets | Financial | NO |

---

# Combined Integration Strategy

## Phase 1: FHIR Bulk API (Current — waiting on JWKS registration)
- **Cost**: Free
- **Provides**: ~60-70% of dashboard data
- **Covers**: All clinical metrics, provider performance, diagnosis patterns, orders/referrals, patient volume, medication tracking
- **Missing**: Financial/billing dollar amounts, scheduling, no-shows

## Phase 2: Connect API (Future)
- **Cost**: Partner agreement + licensing fees
- **Provides**: Remaining ~30-40% of dashboard data
- **Covers**: Revenue, reimbursement, no-shows, claims, A/R, CPT modifiers, charge amounts
- **Required for**: Practice Management tab (revenue, no-shows, collections, referral sources)

## What Each Dashboard Tab Needs

| Tab | FHIR Alone | Needs Connect API |
|---|---|---|
| **Practice Overview** | KPIs (patients, wounds, heal rate, days to heal, visits) ✓ | Revenue KPIs |
| | Healing trajectory chart ✓ | |
| | Diagnosis distribution ✓ | |
| | Provider snapshot table ✓ | |
| | Treatment utilization ✓ | |
| **Provider Performance** | Provider comparison table ✓ | |
| | Healing rate by provider ✓ | |
| | Caseload & acuity ✓ | |
| | E/M code distribution ✓ | |
| | Patient volume (new/follow-up) ✓ | |
| | Orders & referrals table ✓ | |
| **Billing Patterns** | Debridement CPT codes ✓ | Charge amounts per code |
| | Surgical CPT codes ✓ | Modifier codes |
| | E/M code distribution ✓ | |
| | Compression codes ✓ (if in Encounter) | |
| | Z51.89 closures ✓ | |
| | MIST orders ✓ | |
| | Heal rates ✓ | |
| | Patient volume ✓ | |
| | All orders/referrals ✓ | |
| **Patient Explorer** | Patient list ✓ | |
| | Wound history ✓ | |
| | Treatment timeline ✓ | |
| **Patient Populations** | Insurance breakdown ✓ | Revenue per insurance |
| | Patients by status ✓ | |
| | Wound etiology by insurance ✓ | |
| | Chronic conditions ✓ | |
| **Practice Management** | | Total charges ✗ |
| | | Total reimbursed ✗ |
| | | No-shows ✗ |
| | | Collections lag ✗ |
| | | Revenue by carrier ✗ |
| | | Reimbursement rate ✗ |
| | | Referral sources ✗ |
| **AI Insights** | Clinical alerts ✓ | Financial insights ✗ |
| | Protocol adherence ✓ | Scheduling insights ✗ |

## Bottom Line

**FHIR gives you everything Dr. Wahab asked for** in the original requirements — billing patterns by provider, CPT code analysis, heal rates, orders/referrals, patient volume, hospice referrals. The Practice Management tab (revenue, no-shows, collections) requires the Connect API, which is a paid integration.
