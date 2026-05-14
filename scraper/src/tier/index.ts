import 'dotenv/config'

import * as U from '../lib/util.ts'

import cities from './cities.json' with { type: 'json' }
import states from './states.json' with { type: 'json' }
import cityCodes from './cityCodes.json' with { type: 'json' }
import stateCodes from './stateCodes.json' with { type: 'json' }

export const citiesStatesRegex1 = new RegExp(
    '\\b('
        + [...cities, ...states].map(U.regexEscape).join('|')
    + ')\\b',
    'i'
)
export const citiesStatesRegex2 = new RegExp(
    '\\b('
        + [
            ...stateCodes,
            ...cityCodes,
        ].map(U.regexEscape).join('|')
        + ')\\b',
)

// NOTE: if this is changed, add a migration that resets tiers for the companies.
const titleRegex = /(engineer|developer|programmer)/i
export function isJobRelevant(title: string) {
    return titleRegex.test(title)
        && !(
            /(site|sales|solutions?|electrical|mechanical|civil|geotechnical|mining|legal|manufacturing|network|nuclear|design|devops)( (reliability|field))? engineer/i.test(title)
                || /engineer in test/i.test(title)
                || /SDET/.test(title)
        )
}

export function isJobDesired(title: string, description: string | undefined) {
    const ignoreTitle = /\b(director|lead|manager|staff|supervisor|principal|president|qa|quality assurance|machine learning|head of|servicenow|salesforce|forward deployed)\b/i.test(title)
        || /\b(UX)\b/.test(title)
    if(ignoreTitle) return false

    if(!isJobRelevant(title)) return false

    if(description) {
        const descriptionDesired = /(typescript|type script|reactjs|nodejs)/i.test(description)
            || /(Node|React)/.test(description)
        if(!descriptionDesired) return false
    }

    if(description) {
        const years = getYearsOfExperience(description)
        if(years > 5) return false
    }

    return true
}

const getYears = /(?<!\bfor )\b(\d+)(\s*[-–—]\s*\d+)?\s*\+? (yrs|years|experience)/g
export function getYearsOfExperience(description: string) {
    return Math.max(
        ...[...description.matchAll(getYears)]
            .map(it => Number.parseInt(it[2], 10))
            // filter out false-positives from companies writing "we've been doing X 123 years"
            .filter(it => it <= 10),
    )
}

// Relevant location: in the US or remote worldwide
// Desired location: in Illinois or (not (onsite or hybrid) and in the US) or remote worldwide
