import util from 'node:util'
export {}

const description = `
query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) {
  jobPosting(
    organizationHostedJobsPageName: $organizationHostedJobsPageName
    jobPostingId: $jobPostingId
  ) {
    id
    title
    departmentName
    departmentExternalName
    locationName
    locationAddress
    workplaceType
    employmentType
    descriptionHtml
    isListed
    isConfidential
    teamNames
    applicationForm {
      ...FormRenderParts
      __typename
    }
    surveyForms {
      ...FormRenderParts
      __typename
    }
    secondaryLocationNames
    compensationTierSummary
    compensationTiers {
      id
      title
      tierSummary
      __typename
    }
    applicationDeadline
    compensationTierGuideUrl
    scrapeableCompensationSalarySummary
    compensationPhilosophyHtml
    applicationLimitCalloutHtml
    shouldAskForTextingConsent
    candidateTextingPrivacyPolicyUrl
    candidateTextingTermsAndConditionsUrl
    legalEntityNameForTextingConsent
    automatedProcessingLegalNotice {
      automatedProcessingLegalNoticeRuleId
      automatedProcessingLegalNoticeHtml
      __typename
    }
    __typename
  }
}

fragment JSONBoxParts on JSONBox {
  value
  __typename
}

fragment FileParts on File {
  id
  filename
  __typename
}

fragment FormFieldEntryParts on FormFieldEntry {
  id
  field
  fieldValue {
    ... on JSONBox {
      ...JSONBoxParts
      __typename
    }
    ... on File {
      ...FileParts
      __typename
    }
    ... on FileList {
      files {
        ...FileParts
        __typename
      }
      __typename
    }
    __typename
  }
  isRequired
  descriptionHtml
  isHidden
  __typename
}

fragment FormRenderParts on FormRender {
  id
  formControls {
    identifier
    title
    __typename
  }
  errorMessages
  formErrors {
    message
    fieldEntryId
    __typename
  }
  sections {
    title
    descriptionHtml
    fieldEntries {
      ...FormFieldEntryParts
      __typename
    }
    isHidden
    __typename
  }
  sourceFormDefinitionId
  __typename
}
`.trim()

const body = {
    operationName: 'ApiJobBoardWithTeams',
    'variables': {
        organizationHostedJobsPageName: 'aboba',
    },
    "query": `
query ApiJobBoardWithTeams($organizationHostedJobsPageName: String!) {
  jobBoard: jobBoardWithTeams(
    organizationHostedJobsPageName: $organizationHostedJobsPageName
  ) {
    teams {
      id
      name
      externalName
      parentTeamId
      __typename
    }
    jobPostings {
      id
      title
      teamId
      locationId
      locationName
      workplaceType
      employmentType
      secondaryLocations {
        ...JobPostingSecondaryLocationParts
        __typename
      }
      compensationTierSummary
      __typename
    }
    __typename
  }
}

fragment JobPostingSecondaryLocationParts on JobPostingSecondaryLocation {
  locationId
  locationName
  __typename
}
`.trim(),

    //"query ApiJobBoardWithTeams($organizationHostedJobsPageName: String!) {\n  jobBoard: jobBoardWithTeams(\n    organizationHostedJobsPageName: $organizationHostedJobsPageName\n  ) {\n    teams {\n      id\n      name\n      externalName\n      parentTeamId\n      __typename\n    }\n    jobPostings {\n      id\n      title\n      teamId\n      locationId\n      locationName\n      workplaceType\n      employmentType\n      secondaryLocations {\n        ...JobPostingSecondaryLocationParts\n        __typename\n      }\n      compensationTierSummary\n      __typename\n    }\n    __typename\n  }\n}\n\nfragment JobPostingSecondaryLocationParts on JobPostingSecondaryLocation {\n  locationId\n  locationName\n  __typename\n}",
}
/*
{"operationName":"ApiJobPosting","variables":{"organizationHostedJobsPageName":"junior","jobPostingId":"75ebfac3-7f9b-44ac-ac79-f9c05d64b03f"},"query":"query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) {\n  jobPosting(\n    organizationHostedJobsPageName: $organizationHostedJobsPageName\n    jobPostingId: $jobPostingId\n  ) {\n    id\n    title\n    departmentName\n    departmentExternalName\n    locationName\n    locationAddress\n    workplaceType\n    employmentType\n    descriptionHtml\n    isListed\n    isConfidential\n    teamNames\n    applicationForm {\n      ...FormRenderParts\n      __typename\n    }\n    surveyForms {\n      ...FormRenderParts\n      __typename\n    }\n    secondaryLocationNames\n    compensationTierSummary\n    compensationTiers {\n      id\n      title\n      tierSummary\n      __typename\n    }\n    applicationDeadline\n    compensationTierGuideUrl\n    scrapeableCompensationSalarySummary\n    compensationPhilosophyHtml\n    applicationLimitCalloutHtml\n    shouldAskForTextingConsent\n    candidateTextingPrivacyPolicyUrl\n    candidateTextingTermsAndConditionsUrl\n    legalEntityNameForTextingConsent\n    automatedProcessingLegalNotice {\n      automatedProcessingLegalNoticeRuleId\n      automatedProcessingLegalNoticeHtml\n      __typename\n    }\n    __typename\n  }\n}\n\nfragment JSONBoxParts on JSONBox {\n  value\n  __typename\n}\n\nfragment FileParts on File {\n  id\n  filename\n  __typename\n}\n\nfragment FormFieldEntryParts on FormFieldEntry {\n  id\n  field\n  fieldValue {\n    ... on JSONBox {\n      ...JSONBoxParts\n      __typename\n    }\n    ... on File {\n      ...FileParts\n      __typename\n    }\n    ... on FileList {\n      files {\n        ...FileParts\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n  isRequired\n  descriptionHtml\n  isHidden\n  __typename\n}\n\nfragment FormRenderParts on FormRender {\n  id\n  formControls {\n    identifier\n    title\n    __typename\n  }\n  errorMessages\n  formErrors {\n    message\n    fieldEntryId\n    __typename\n  }\n  sections {\n    title\n    descriptionHtml\n    fieldEntries {\n      ...FormFieldEntryParts\n      __typename\n    }\n    isHidden\n    __typename\n  }\n  sourceFormDefinitionId\n  __typename\n}"}
*/

// ?op=ApiJobBoardWithTeams
const result = await fetch('https://jobs.ashbyhq.com/api/non-user-graphql', {
    method: 'POST',
    headers: {
        'content-type': 'application/json',
    },
    body: JSON.stringify(body),
}).then(it => it.json())

console.log(util.inspect(result, { depth: Infinity, colors: true }))
