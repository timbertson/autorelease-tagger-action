const core = require('@actions/core')
const lib = require('./lib.js')

exports.main = function() {
	try {
		let env = {}
		lib.parseOpts.keys.forEach(function(key) {
			let value = core.getInput(key)
			if (value != '') {
				env[key] = value
			}
		})
		let opts = lib.parseOpts(env)
		let nextVersion = lib.getNextVersion(opts)
		if (nextVersion != null) {
			let versionTag = lib.applyVersion(opts, nextVersion)
			core.info("Applying version "+ tag)
			core.setOutput('versionTag', versionTag)
		} else {
			core.info("No version release triggered")
		}
	} catch(e) {
		core.setFailed(e.message)
	}
}

