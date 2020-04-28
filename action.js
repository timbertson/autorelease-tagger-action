const core = require('@actions/core')
const lib = require('./lib.js')

function main() {
	try {
		let env = {}
		lib.parseOpts.keys.forEach(function(key) {
			let value = core.getInput(key)
			if (value != '') {
				env[key] = value
			}
		})
		let opts = lib.parseOpts(env)
		core.info("Parsed options: " + JSON.stringify(opts))
		let nextVersion = lib.getNextVersion(opts)
		if (nextVersion != null) {
			let tag = lib.applyVersion(opts, nextVersion)
			core.setOutput('tag', tag)
			core.setOutput('version', nextVersion)
		} else {
			core.info("No version release triggered")
		}
	} catch(e) {
		console.log(e)
		core.setFailed(e.message)
	}
}

main()
