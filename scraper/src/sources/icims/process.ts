import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

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

const rl = readline.createInterface({
    input: fs.createReadStream(path.join(import.meta.dirname, 'thirdParty', 'icims.csv')),
    crlfDelay: Infinity,
})

for await (const line of rl) {
    if(line === 'name,slug,url') continue
    addUrl(line.substring(line.indexOf(',', line.indexOf(',') + 1) + 1))
}

console.log('Found', companies.size, 'companies')

fs.writeFileSync(
    path.join(import.meta.dirname, 'companyNames.json'),
    JSON.stringify([...companies], undefined, 1),
)

function isValidSubdomain(subdomain: string) {
    const labelRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/
    return subdomain.length > 0 && labelRegex.test(subdomain) && subdomain !== 'www'
}
