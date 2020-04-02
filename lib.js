let child_process = require('child_process')
let fs = require('fs')

function sh() {
	let args = Array.prototype.slice.call(arguments)
	console.log("+ " + args.join(' '))
	let result = child_process.spawnSync(args[0], args.slice(1), {
		encoding: 'utf8',
		stdio: ['inherit', 'pipe', 'inherit']
	})
	// console.log(result)
	if (result.status != 0) {
		throw new Error("Command failed: " + args.join(' '))
	}
	return result.stdout.trim()
}

function renderVersion(v) {
	return "v" + v.join('.')
}

function extendTo(length, array) {
	array = array.slice()
	while(array.length < length) {
		array.push(0)
	}
	return array
}

function initialVersion(opts) {
	return extendTo(opts.numComponents, [])
}

function applyBump(opts, current, action) {
	if (!action.release) return null
	let bumpIdx = action.bump
	if (opts.minBump != null && bumpIdx > opts.minBump) {
		// requested e.g. a patch bump, but minBump is minor. That's fine, just promote it
		bumpIdx = minBump
		console.log("Note: forcing "+renderBumpIndex(bumpIdx)+" because of minBump")
	}
	if (bumpIdx < opts.maxBump) {
		throw new Error("Requested bump ("+renderBumpIndex(bumpIdx)+") is greater than maxBump ("+renderBumpIndex(opts.maxBump)+")")
	}

	if (bumpIdx >= opts.numComponents) {
		throw new Error("Tried to bump component " + renderBumpIndex(bumpIdx) + " but there are only "+ current.length + " components")
	}
	current = extendTo(opts.numComponents, current)
	let version = current.slice(0, bumpIdx)
	version.push(current[bumpIdx]+1)
	return extendTo(opts.numComponents, version)
}

function parsePart(p) {
	let digits = p.match(/^[0-9]+/)
	if (digits == null) {
		throw new Error("Invalid version component: " + p)
	}
	return parseInt(digits[0], 10)
}

function parseVersion(v) {
	if (v[0] == 'v') {
		let parts = v.slice(1).split('.')
		return parts.map(parsePart)
	} else {
		throw new Error("Invalid version string: " + v)
	}
}

function parseGitDescribe(output) {
	parts = output.split('-')
	if (parts.length == 1) {
		// just a git commit
		return null
	} else if (parts.length > 2) {
		// output is e.g. v1.3.0-3-gf32721e
		let tag = parts.slice(0, parts.length - 2).join('-')
		return {
			tag: tag,
			version: parseVersion(tag)
		}
	} else {
		throw new Error("Unexpected `git describe` output: " + output)
	}
}

function commitLinesSince(tag) {
	return sh('git', 'log', '--format=format:%s', tag + '..' + getBaseRef())
}

let bumpAliases = ["major", "minor", "patch"]
function renderBumpIndex(i) {
	return bumpAliases[i] || "[index " + String(i) + "]"
}

function parseBumpAlias(alias) {
	switch (alias) {
		case "major": return 0
		case "minor": return 1
		case "patch": return 2
		default: throw new Error("Invalid bump alias: " + alias)
	}
}

function parseCommitLines(opts, commitLines) {
	let alwaysRelease = opts.releaseTrigger == 'always'
	function parse(label) {
		let withoutRelease = label.replace(/-release$/, "")
		if (bumpAliases.includes(withoutRelease)) {
			return {
				bump: parseBumpAlias(withoutRelease),
				release: withoutRelease != label
			}
		} else {
			return {
				bump: null,
				release: (label == 'release')
			}
		}
	}

	if (commitLines.length == 0) {
		return { release: false, bump: null }
	}
	let tags = commitLines.match(/(^| )#\S+(:| |$)/gm) || []
	// console.log("tags: " + JSON.stringify(tags))
	let labels = (tags
		.map((tag) => tag.trim().replace(/^#/, '').replace(/:$/, ''))
		.map(parse)
	)
	// console.log(JSON.stringify(commitLines) + ' => ' + JSON.stringify(labels))

	let doRelease = Boolean(opts.releaseTrigger == 'always' || labels.find((desc) => desc.release))
	let bumps = labels.map((d) => d.bump).filter((x) => x != null).sort((a,b) => a - b)
	return {
		release: doRelease,
		bump: bumps.length > 0 ? bumps[0] : opts.defaultBump
	}
}

let parseOpts = exports.parseOpts = function(env) {
	function map(key, fn, dfl) {
		if (env.hasOwnProperty(key)) {
			return fn(env[key])
		} else {
			return dfl === undefined ? null : dfl
		}
	}
	function orElse(key, dfl) {
		return map(key, (x) => x, dfl)
	}
	function validate(key, dfl, fn) {
		let v = orElse(key, dfl)
		if (fn(v)) {
			return v
		} else {
			throw new Error("invalid "+key+": " + v)
		}
	}

	let defaultDoPush = process.env['GITHUB_EVENT_NAME'] == 'pull_request' ? 'false' : 'true'

	return {
		numComponents: map('numComponents', (i) => parseInt(i), 3),
		releaseTrigger: validate("releaseTrigger", "always", (x) => ["always", "commit"].includes(x)),
		defaultBump: parseBumpAlias(orElse("defaultBump", "minor")),
		maxBump: parseBumpAlias(orElse("maxBump", "major")),
		minBump: map('minBump', parseBumpAlias, null),
		doTag: validate("doTag", "true", (x) => ["true","false"].includes(x)) === "true",
		doPush: validate("doPush", "true", (x) => ["true","false"].includes(x)) === "true",
	}
}
parseOpts.keys = ['numComponents', 'releaseTrigger', 'defaultBump', 'maxBump', 'minBump', 'doTag', 'doPush']

function getBaseRef() {
	// if we're running on a PR, use the head ref (branch to be merged)
	// instead of the HEAD (which is actually a merge of the PR against `master`)
	let prBranch = process.env['GITHUB_HEAD_REF']
	return prBranch ? 'origin/'+prBranch : 'HEAD'
}

let getNextVersion = exports.getNextVersion = function(opts) {
	let fetchCmd = ['git', 'fetch', '--tags']
	if (fs.existsSync('.git/shallow')) {
		fetchCmd.push('--unshallow')
	}
	sh.apply(null, fetchCmd)
	let describeOutput = sh('git', 'describe', '--tags', '--match', 'v*', '--always', '--long', getBaseRef())
	console.log("Git describe output: "+ describeOutput)
	let current = parseGitDescribe(describeOutput)
	if (current == null) {
		console.log("No current version detected")
		return initialVersion(opts)
	} else {
		console.log("Current version: " + renderVersion(current.version) + " (from tag "+current.tag+")")
	}
	let action = parseCommitLines(opts, commitLinesSince(current.tag))
	return applyBump(opts, current.version, action)
}

let applyVersion = exports.applyVersion = function(opts, version) {
	let tag = renderVersion(version)
	console.log("Applying version "+ tag)
	if (opts.doTag) {
		sh('git', 'tag', tag, 'HEAD')
		if (opts.doPush) {
			sh('git', 'push', 'tag', tag)
		}
	}
	return tag
}

exports.main = function() {
	let opts = parseOpts(process.env)
	let nextVersion = getNextVersion(opts)
	if (nextVersion != null) {
		let versionTag = applyVersion(opts, nextVersion)
		console.log("::set-output name=versionTag::"+versionTag)
	} else {
		console.log("No version release triggered")
	}
}

exports.test = function() {
	function assertEq(a,b) {
		let aDesc = JSON.stringify(a)
		let bDesc = JSON.stringify(b)
		if(aDesc !== bDesc) {
			throw new Error("Expected "+ bDesc + ", got "+ aDesc)
		}
	}

	function assertThrows() {
		let args = Array.prototype.slice.call(arguments)
		let fn = args.shift()
		let msg = args.pop()
		let threw = false
		try {
			fn.apply(null, args)
		} catch(e) {
			threw = true
			assertEq(e.message, msg)
		}
		if (!threw) {
			throw new Error("Function didn't fail (expected: " + msg + ")")
		}
	}

	assertEq(parsePart("08"), 8)
	assertEq(parsePart("1-rc2"), 1)
	assertThrows(parsePart, "v1", "Invalid version component: v1")
	assertThrows(parsePart, "", "Invalid version component: ")

	assertEq(parseVersion("v1.2.3"), [1,2,3])
	assertEq(parseVersion("v1"), [1])
	assertThrows(parseVersion, "1", "Invalid version string: 1")

	assertEq(parseGitDescribe("v1.2.3-1-gabcd"), { tag: "v1.2.3", version: [1,2,3]})
	assertEq(parseGitDescribe("v1.2-rc1.3-1-gabcd"), { tag: "v1.2-rc1.3", version: [1,2,3] })
	assertEq(parseGitDescribe("gabcd"), null)
	assertThrows(parseGitDescribe, "v1.2-gabcd", "Unexpected `git describe` output: v1.2-gabcd")

	let defaultOpts = parseOpts({})
	let manualRelease = { releaseTrigger: 'commit', defaultBump: 1 }
	function assertParseCommitLines(lines, expected, opts) {
		if (!opts) { opts = defaultOpts }
		assertEq(parseCommitLines(opts, lines.join("\n")), expected)
	}
	assertParseCommitLines([], { release: false, bump: null })
	assertParseCommitLines(["#major thing"], { release: true, bump: 0 })
	assertParseCommitLines(["#minor"], { release: true, bump: 1 })
	assertParseCommitLines(["some #patch"], { release: true, bump: 2 })
	assertParseCommitLines(["#other: thing"], { release: true, bump: 1 })
	assertParseCommitLines(["#other: thing"], { release: false, bump: 1 }, manualRelease)
	assertParseCommitLines(["#release: thing"], { release: true, bump: 1 }, manualRelease)
	assertParseCommitLines(["#major-release: thing"], { release: true, bump: 0 }, manualRelease)

	assertParseCommitLines(["#release", "#minor"], { release: true, bump: 1 }, manualRelease)
	assertParseCommitLines(["#minor", "#major:"], { release: true, bump: 0 })
	assertParseCommitLines(["#minor", "#patch"], { release: true, bump: 1 })
	// only matches tags on their own, not in urls/etc
	assertParseCommitLines(["http://foo#major"], { release: true, bump: 1 })
	assertParseCommitLines(["#majorbusiness"], { release: true, bump: 1 })
	assertParseCommitLines(['#ma','jor'], { release: true, bump: 1 })

	assertEq(applyBump(defaultOpts, [1,2,3], { release: true, bump: 0 }), [2,0,0])
	assertEq(applyBump(defaultOpts, [1,2,3], { release: true, bump: 1 }), [1,3,0])
	assertEq(applyBump(defaultOpts, [1,2,3], { release: true, bump: 2 }), [1,2,4])
	assertThrows(applyBump, defaultOpts, [1,2,3], { release: true, bump: 3 }, "Tried to bump component [index 3] but there are only 3 components")
	assertEq(applyBump({ numComponents: 4 }, [1,2], { release: true, bump: 3 }), [1,2,0,1])
	assertThrows(applyBump, {maxBump: 1}, [1,2,3], { release: true, bump: 0 }, "Requested bump (major) is greater than maxBump (minor)")

	assertEq(parseOpts({}), {
		numComponents:3,
		releaseTrigger:"always",
		defaultBump:1,
		maxBump:0,
		minBump:null,
		doTag:true,
		doPush:true
	})

	assertEq(parseOpts({
		releaseTrigger: 'commit',
		defaultBump: 'major',
		maxBump: 'patch',
		minBump: 'minor',
		doTag: 'true',
		doPush: 'false',
	}), {
		numComponents: 3,
		releaseTrigger: "commit",
		defaultBump: 0,
		maxBump: 2,
		minBump: 1,
		doTag: true,
		doPush: false
	})

	assertEq(sh("echo", "1", "2"), "1 2")
	assertThrows(sh, "cat", "/ does_not_exist", "Command failed: cat / does_not_exist")
}
