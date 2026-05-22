import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

const companies = new Set<string>()
function addUrl(url: string) {
    const u = new URL(url)
    const companyId = u.searchParams.get('cid')
    if(companyId && companyId.length === 36) companies.add(companyId)
}

const rl = readline.createInterface({
    input: fs.createReadStream(path.join(import.meta.dirname, 'archive-urls.txt')),
    crlfDelay: Infinity,
})

for await (const url of rl) {
    addUrl(url)
}

console.log('Found', companies.size, 'companies')

fs.writeFileSync(
    path.join(import.meta.dirname, 'companies.json'),
    JSON.stringify([...companies], undefined, 1),
)
