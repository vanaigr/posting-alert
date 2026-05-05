import fs from 'node:fs'
import path from 'node:path'

const urls1: string[] = fs.readFileSync(path.join(import.meta.dirname, 'archive-urls.txt')).toString().split('\n')
const names3: string[] = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'thirdParty', 'bamboohr_companies.json')).toString())

const prefixes = ['http://', 'https://',]

const companies = new Set<string>()
function addUrl(url: string) {
    const prefixLen = Math.max(...prefixes.map((it): number => {
        if(url.startsWith(it)) return it.length
        return -1
    }))
    if(prefixLen === -1) {
        console.log('invalid url', url)
        return
    }

    const end = url.indexOf('.')
    if(end === -1) {
        console.log('invalid url', url)
    }

    const companySlug = url.slice(prefixLen, end)
    const name = decodeURIComponent(companySlug)
    if(isValidSubdomain(name)) {
        companies.add(name.toLowerCase())
    }
}

for(const url of urls1) {
    addUrl(url)
}
for(const name of names3) {
    if(isValidSubdomain(name)) {
        companies.add(name.toLowerCase())
    }
}

console.log('Found', companies.size, 'companies')

fs.writeFileSync(
    path.join(import.meta.dirname, 'companyNames.json'),
    JSON.stringify([...companies]),
)

function isValidSubdomain(subdomain: string) {
    const labelRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/
    return subdomain.length > 0 && labelRegex.test(subdomain) && subdomain !== 'www'
}
