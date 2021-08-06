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

let renderVersion = exports.renderVersion = function renderVersion(v) {
	return v.join('.')
}

function tagOfVersion(v) {
	return "v" + renderVersion(v)
}

function extendTo(length, array) {
	array = array.slice()
	while(array.length < length) {
		array.push(0)
	}
	return array
}

function initialVersion(opts) {
	return extendTo(opts.numComponents, opts.pinComponents)
}

const applyBump = (function() {
	function doApply(opts, current, bumpIdx) {
		current = extendTo(opts.numComponents, current)
		let version = current.slice(0, bumpIdx)
		version.push(current[bumpIdx]+1)
		let proposed = extendTo(opts.numComponents, version)

		// if pinComponents is set, ensure we bump up to the version required:
		for (let i=0; i<opts.pinComponents.length; i++) {
			let part = proposed[i]
			let required = opts.pinComponents[i]
			if (required < part) {
				throw new Error("New version ("+ tagOfVersion(proposed) +") is incompatible with versionTemplate ("+opts.versionTemplate+")")
			} else if (required > part) {
				return doApply(opts, proposed, i)
			}
		}
		return proposed
	}

	return (function applyBump(opts, current, action) {
		let bumpIdx = action.bump

		if (opts.minBump != null && bumpIdx > opts.minBump) {
			// requested e.g. a patch bump, but minBump is minor. That's fine, just promote it
			bumpIdx = opts.minBump
			console.log("Note: forcing "+renderBumpIndex(bumpIdx)+" because of minBump")
		}
		if (bumpIdx < opts.maxBump) {
			throw new Error("Requested bump ("+renderBumpIndex(bumpIdx)+") is greater than maxBump ("+renderBumpIndex(opts.maxBump)+")")
		}

		if (bumpIdx >= opts.numComponents) {
			throw new Error("Tried to bump component " + renderBumpIndex(bumpIdx) + " but there are only "+ current.length + " components")
		}
		
		return doApply(opts, current, bumpIdx)
	})
})()

function parsePart(p) {
	let digits = p.match(/^[0-9]+/)
	if (digits == null) {
		throw new Error("Invalid version component: " + p)
	}
	return parseInt(digits[0], 10)
}

function splitParts(v) {
	if (v[0] == 'v') {
		v = v.slice(1)
	}
	return v.split('.')
}

function parseVersion(v) {
	return splitParts(v).map(parsePart)
}

let parseVersionTemplate = function(v) {
	if (v.indexOf('refs/heads/') === 0) {
		v = v.slice(11)
	}
	if (v === '') {
		return null
	}
	let parts = splitParts(v)
	try {
		// this is unfortunately lax, but github's super weak expression language
		// warrants being lenient here
		if (parts[0] != 'x') {
			parsePart(parts[0])
		}
	} catch {
		console.log("Ignoring versionTemplate ("+ v +") as it looks like a branch name")
		return null
	}
	let pinComponents = []
	let numComponents = parts.length
	let maxBump = null
	let minBump = null
	let err = new Error("Invalid version template: " + v)
	parts.forEach(function(part, idx) {
		if (part == 'x') {
			if (minBump !== null) {
				// we already saw `x.0`, all the following parts should be `0`
				throw err
			}
			if (maxBump === null) {
				maxBump = idx
			}
		} else {
			if (maxBump !== null) {
				// we already saw an `x` component, all the following ones should be either `x` or `0`
				if (part == '0') {
					if (minBump == null) {
						minBump = idx-1
					}
				} else {
					throw err
				}
			} else {
				pinComponents.push(parsePart(part))
			}
		}
	})
	if (maxBump == null) {
		// we didn't see any `.x` components, e.g it's a plain `v1.2`. This is only useful if you explicitly set `numComponents` to 3, which ends up acting like `v1.2.x`
		maxBump = numComponents
	}
	return { numComponents, maxBump, minBump, pinComponents }
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
	// if we're running on a PR, use the head ref (branch to be merged)
	// instead of the HEAD (which is actually a merge of the PR against `master`)
	return sh('git', 'log', '--format=format:%s', tag + '..' + getPRImplementationBranch(), '--')
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
	let tags = commitLines.match(/\[\S+\]/gm) || []
	// console.log("tags: " + JSON.stringify(tags))
	let labels = (tags
		.map((tag) => tag.trim().replace(/\[|\]/g, ''))
		.map(parse)
	)
	// console.log(JSON.stringify(commitLines) + ' => ' + JSON.stringify(labels))

	let doRelease = Boolean(opts.releaseTrigger == 'always' || labels.find((desc) => desc.release))
	let bumps = labels.map((d) => d.bump).filter((x) => x != null).sort((a,b) => a - b)
	let bump = opts.defaultBump
	if (bumps.length > 0) {
		bump = bumps[0]
		console.log("Applying explicit bump: " + renderBumpIndex(bump))
	}
	return {
		release: doRelease,
		bump
	}
}

let parseOpts = exports.parseOpts = function(env) {
	function map(key, fn, dfl) {
		if (parseOpts.keys.indexOf(key) === -1) {
			throw new Error("key not defined in parseOpts.keys: " + key)
		}
		if (env.hasOwnProperty(key)) {
			return fn(env[key])
		} else {
			return dfl;
		}
	}
	let identity = (x) => x
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

	function preferVersionTemplate(key, { supplied, fromVersion }) {
		console.log("Using `"+key+"` derived from `versionTemplate` ("+fromVersion+") over explicit parameter ("+supplied+")")
		return fromVersion
	}

	function useMaxOfSettings(key, { supplied, fromVersion }) {
		let result = Math.max(supplied, fromVersion)
		console.log("Using maximum from `"+key+"` ("+supplied+") and `versionTemplate` ("+fromVersion+")")
		return result
	}

	let versionTemplateOpts = map('versionTemplate', parseVersionTemplate, null)
	// console.log('opts', env, versionTemplateOpts)

	function mergeFromVersionTemplate(key, fn, merge, dfl) {
		if (versionTemplateOpts === null) {
			return map(key, fn, dfl)
		}
		let supplied = map(key, fn, null)
		let fromVersion = versionTemplateOpts[key]
		if (supplied === null) {
			return fromVersion
		}
		if (supplied === fromVersion) {
			return supplied
		} else {
			return merge(key, { supplied, fromVersion })
		}
	}

	let defaultDoPush = process.env['GITHUB_EVENT_NAME'] == 'pull_request' ? 'false' : 'true'

	let isBoolString = (x) => ["true","false"].includes(x)
	let opts = {
		releaseTrigger: validate("releaseTrigger", "always", (x) => ["always", "commit"].includes(x)),

		numComponents: mergeFromVersionTemplate('numComponents', (i) => parseInt(i), useMaxOfSettings, 3),
		minBump: mergeFromVersionTemplate('minBump', parseBumpAlias, preferVersionTemplate, null),
		maxBump: mergeFromVersionTemplate("maxBump", parseBumpAlias, preferVersionTemplate, 0),
		pinComponents: mergeFromVersionTemplate('pinComponents', identity, preferVersionTemplate, []),

		defaultBump: map('defaultBump', parseBumpAlias, null),
		doTag: validate("doTag", "true", isBoolString) === "true",
		doPush: validate("doPush", "true", isBoolString) === "true",
		exportEnv: map('exportEnv', identity, null),
	}

	if (opts.defaultBump == null) {
		let minDefaultBump = opts.minBump == null ? opts.numComponents : opts.minBump
		let maxDefaultBump = opts.maxBump == null ? 0 : opts.maxBump
		// Aim for 1, but cap to the range defined by minDefault / maxDefault
		// Due to the visual (left->right) indexes we want an index <= minDefaultBump
		// and >= maxDefaultBump
		opts.defaultBump = Math.min(Math.max(1, maxDefaultBump), minDefaultBump)
	}
	return opts
}
parseOpts.keys = ['numComponents', 'releaseTrigger', 'defaultBump', 'maxBump', 'minBump', 'doTag', 'doPush', 'versionTemplate', 'pinComponents', 'exportEnv']

function getPRDestinationBranch() {
	let prBranch = process.env['GITHUB_BASE_REF']
	return prBranch ? 'origin/'+prBranch : 'HEAD'
}

function getPRImplementationBranch() {
	let prBranch = process.env['GITHUB_HEAD_REF']
	return prBranch ? 'origin/'+prBranch : 'HEAD'
}

let getNextVersion = exports.getNextVersion = function(opts) {
	let fetchCmd = ['git', 'fetch', '--tags']
	if (fs.existsSync('.git/shallow')) {
		fetchCmd.push('--unshallow')
	}
	sh.apply(null, fetchCmd)

	// For a PR, we find the last tag reachable from the base ref (the branch we're merging into),
	// rather than HEAD. Github creates the HEAD merge commit when you create / push a PR,
	// so it won't always contain everything in the target branch:
	//
	//   * master (v1.2.3)
	//   |
	//   |  * HEAD (PR auto merge commit)
	//   |/ |
	//   |  * PR: my cool feature
	//   | /
	//   * master^ (v1.2.2)
	//   |
	//   (...)
	//
	// If we just used HEAD, we'd pick a conflicting `v1.2.3` for this PR and fail,
	// even though once merged it would correctly pick v1.2.4
	//
	// In the case where you merge a version branch into master (i.e. both have version tags),
	// the PR will naturally only consider the master branch. Once merged, `--first-parent`
	// will ensure that `git describe` only searches the mainline history, not the version branch.

	let tagSearchRef = getPRDestinationBranch()

	let describeOutput = sh('git', 'describe', '--tags', '--first-parent', '--match', 'v*', '--always', '--long', tagSearchRef)
	console.log("Git describe output: "+ describeOutput)
	let current = parseGitDescribe(describeOutput)
	if (current == null) {
		console.log("No current version detected")
		return initialVersion(opts)
	} else {
		console.log("Current version: " + renderVersion(current.version) + " (from tag "+current.tag+")")
	}
	let action = parseCommitLines(opts, commitLinesSince(current.tag))
	if (!action.release) {
		return null
	}
	return applyBump(opts, current.version, action)
}

let applyVersion = exports.applyVersion = function(opts, version) {
	let tag = tagOfVersion(version)
	console.log("Applying version "+ tag)
	if (opts.doTag) {
		sh('git', 'tag', tag, 'HEAD')
		if (opts.doPush) {
			sh('git', 'push', 'origin', 'tag', tag)
		}
	}
	return tag
}

exports.main = function() {
	let opts = parseOpts(process.env)
	let nextVersion = getNextVersion(opts)
	if (nextVersion != null) {
		applyVersion(opts, nextVersion)
	} else {
		console.log("No version release triggered")
	}
}

exports.test = function() {
	function assertEq(a,b, ctx) {
		if(b === undefined) {
			throw new Error("Expected value is undefined")
		}
		let aDesc = JSON.stringify(a)
		let bDesc = JSON.stringify(b)
		if(aDesc !== bDesc) {
			let desc = "Expected "+ bDesc + ", got "+ aDesc
			if (ctx) desc += " ("+ctx+")"
			throw new Error(desc)
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
	assertEq(parseVersion("1"), [1])
	assertThrows(parseVersion, "a", "Invalid version component: a")

	assertEq(parseGitDescribe("v1.2.3-1-gabcd"), { tag: "v1.2.3", version: [1,2,3]})
	assertEq(parseGitDescribe("v1.2-rc1.3-1-gabcd"), { tag: "v1.2-rc1.3", version: [1,2,3] })
	assertEq(parseGitDescribe("gabcd"), null)
	assertThrows(parseGitDescribe, "v1.2-gabcd", "Unexpected `git describe` output: v1.2-gabcd")

	assertEq(parseVersionTemplate(""), null)
	assertEq(parseVersionTemplate("v1.x"),   { numComponents: 2, maxBump: 1, minBump: null, pinComponents: [1] })
	assertEq(parseVersionTemplate("refs/heads/v1.x"), { numComponents: 2, maxBump: 1, minBump: null, pinComponents: [1] })
	assertEq(parseVersionTemplate("refs/heads/1.x"), { numComponents: 2, maxBump: 1, minBump: null, pinComponents: [1] })
	assertEq(parseVersionTemplate("refs/heads/1"), { numComponents: 1, maxBump: 1, minBump: null, pinComponents: [1] })
	assertEq(parseVersionTemplate("refs/heads/master"), null)
	assertEq(parseVersionTemplate("v1.2.x"), { numComponents: 3, maxBump: 2, minBump: null, pinComponents: [1,2] })
	assertEq(parseVersionTemplate("v3.x.x"), { numComponents: 3, maxBump: 1, minBump: null, pinComponents: [3] })
	assertEq(parseVersionTemplate("v3.x.0"), { numComponents: 3, maxBump: 1, minBump: 1, pinComponents: [3] })
	assertEq(parseVersionTemplate("vx.x.x"), { numComponents: 3, maxBump: 0, minBump: null, pinComponents: [] })
	assertEq(parseVersionTemplate("vx.x.0"), { numComponents: 3, maxBump: 0, minBump: 1, pinComponents: [] })
	assertEq(parseVersionTemplate("vx.0.0"), { numComponents: 3, maxBump: 0, minBump: 0, pinComponents: [] })
	assertThrows(parseVersionTemplate, "v3.x.2", "Invalid version template: v3.x.2")
	assertThrows(parseVersionTemplate, "v3.x.2", "Invalid version template: v3.x.2")
	assertThrows(parseVersionTemplate, "vx.0.x", "Invalid version template: vx.0.x")
	assertThrows(parseVersionTemplate, "v1.a.x", "Invalid version component: a")

	let defaultOpts = parseOpts({})
	let manualRelease = { releaseTrigger: 'commit', defaultBump: 1 }
	function assertParseCommitLines(lines, expected, opts) {
		if (!opts) { opts = defaultOpts }
		assertEq(parseCommitLines(opts, lines.join("\n")), expected, "parsing lines: " + JSON.stringify(lines))
	}
	assertParseCommitLines([], { release: false, bump: null })
	assertParseCommitLines(["[major] thing"], { release: true, bump: 0 })
	assertParseCommitLines(["[minor]"], { release: true, bump: 1 })
	assertParseCommitLines(["some [patch]"], { release: true, bump: 2 })
	assertParseCommitLines(["[other]: thing"], { release: true, bump: 1 })
	assertParseCommitLines(["[other]: thing"], { release: false, bump: 1 }, manualRelease)
	assertParseCommitLines(["[release]: thing"], { release: true, bump: 1 }, manualRelease)
	assertParseCommitLines(["[major-release]: thing"], { release: true, bump: 0 }, manualRelease)

	assertParseCommitLines(["[release]", "[minor]"], { release: true, bump: 1 }, manualRelease)
	assertParseCommitLines(["[minor]", "[major]:"], { release: true, bump: 0 })
	assertParseCommitLines(["[minor]", "[patch]"], { release: true, bump: 1 })
	assertParseCommitLines(['[ma','jor]'], { release: true, bump: 1 })

	assertEq(initialVersion({...defaultOpts, numComponents: 2}), [0,0])
	assertEq(initialVersion({...defaultOpts, pinComponents: [2,3,0], numComponents: 4}), [2,3,0,0])

	assertEq(applyBump(defaultOpts, [1,2,3], { bump: 0 }), [2,0,0])
	assertEq(applyBump(defaultOpts, [1,2,3], { bump: 1 }), [1,3,0])
	assertEq(applyBump(defaultOpts, [1,2,3], { bump: 2 }), [1,2,4])
	assertEq(applyBump({ ...defaultOpts, minBump: 0 }, [1,2,3], { bump: 2 }), [2,0,0])
	assertThrows(applyBump, defaultOpts, [1,2,3], { bump: 3 }, "Tried to bump component [index 3] but there are only 3 components")
	assertEq(applyBump({...defaultOpts, numComponents: 4 }, [1,2], { bump: 3 }), [1,2,0,1])
	assertThrows(applyBump, {...defaultOpts, maxBump: 1}, [1,2,3], { bump: 0 }, "Requested bump (major) is greater than maxBump (minor)")

	// NOTE: we apply validation before applying pinComponents.
	// If you specify maxBump=minor and versionTemplate=2.x on
	// a commit above v1.3, we'll take that as a request to start a 2.x branch
	assertEq(applyBump({...defaultOpts, pinComponents: [2, 8]}, [1,2,3], { bump: 2 }), [2,8,0])
	assertEq(applyBump({...defaultOpts, pinComponents: [1, 2]}, [1,2,3], { bump: 2 }), [1,2,4])
	assertEq(applyBump({...defaultOpts, pinComponents: [1, 3]}, [1,2,3], { bump: 2 }), [1,3,0])
	assertEq(applyBump({...defaultOpts, pinComponents: [1, 3], numComponents: 4}, [0,0,0], { bump: 3 }), [1, 3, 0, 0])
	assertThrows(applyBump, {...defaultOpts, pinComponents: [1,1], versionTemplate: "v1.1.x" }, [1,2,3], { bump: 2 }, "New version (v1.2.4) is incompatible with versionTemplate (v1.1.x)")
	assertThrows(applyBump, {...defaultOpts, pinComponents: [1], versionTemplate: "v1.x.x" }, [1,2,3], { bump: 0 }, "New version (v2.0.0) is incompatible with versionTemplate (v1.x.x)")

	assertEq(parseOpts({}), {
		releaseTrigger:"always",
		numComponents:3,
		minBump:null,
		maxBump:0,
		pinComponents: [],
		defaultBump:1,
		doTag:true,
		doPush:true,
		exportEnv: null,
	})

	assertEq(parseOpts({
		releaseTrigger: 'commit',
		defaultBump: 'major',
		maxBump: 'patch',
		minBump: 'minor',
		doTag: 'true',
		doPush: 'false',
		exportEnv: null,
	}), {
		releaseTrigger: "commit",
		numComponents: 3,
		minBump: 1,
		maxBump: 2,
		pinComponents: [],
		defaultBump: 0,
		doTag: true,
		doPush: false,
		exportEnv: null,
	})

	assertEq(parseOpts({ minBump: 'patch' }).defaultBump, 1)
	assertEq(parseOpts({ minBump: 'major' }).defaultBump, 0)
	assertEq(parseOpts({ maxBump: 'patch' }).defaultBump, 2)

	assertEq(parseOpts({versionTemplate: 'v2.x'}).numComponents, 2)
	assertEq(parseOpts({versionTemplate: 'vx.0'}).minBump, 0)
	assertEq(parseOpts({versionTemplate: 'v1.x'}).maxBump, 1)
	assertEq(parseOpts({versionTemplate: 'v1.x'}).pinComponents, [1])

	// test precedence of passing both versionTemplate and explicit settings:
	assertEq(parseOpts({versionTemplate: 'v2.x', numComponents: 3}).numComponents, 3, 'max')
	assertEq(parseOpts({versionTemplate: 'v2.x.x', numComponents: 2}).numComponents, 3, 'max')
	assertEq(parseOpts({versionTemplate: 'v2.x.x', minBump: 'minor'}).minBump, null, 'prefer versionTemplate')
	assertEq(parseOpts({versionTemplate: 'vx.x.x', maxBump: 'minor'}).maxBump, 0, 'prefer versionTemplate')

	assertEq(sh("echo", "1", "2"), "1 2")
	assertThrows(sh, "cat", "/ does_not_exist", "Command failed: cat / does_not_exist")

	function getAndApply(opts) {
		let version = getNextVersion(opts)
		if (version == null) {
			throw new Error("New version was not generated")
		}
		applyVersion(opts, version)
		return version
	}

	function dumpState() {
		console.log(sh('git', 'log', '--color', '--graph',
			'--pretty=format:%C(yellow)%h%Creset -%C(bold blue)%d%Creset %s %Cgreen(%cr) %C(bold)<%an>%Creset',
			'--abbrev-commit', '--date=relative', '--date-order', 'HEAD'))
	}

	// "integration test" of sorts, running with some real git repositories
	let os = require('os')
	let tempdir = fs.mkdtempSync(os.tmpdir() + '/autorelease-tagger-')
	try {
		console.log('tempdir: ' + tempdir)
		let origin = tempdir + '/origin'
		fs.mkdirSync(origin)
		process.chdir(origin)
		sh('git', 'init')
		function commit(msg) {
			sh('git', 'commit', '--allow-empty', '-m', msg)
		}
		commit('initial')
		let opts = {...defaultOpts, doPush: false}

		assertEq(getAndApply(opts), [0,0,0])

		commit('work')
		assertEq(getAndApply(opts), [0,1,0])

		commit('[major] work')
		assertEq(getAndApply(opts), [1,0,0])
		// ensure v1.0.0 is further away in the history than the v0.1.1
		// we're going to make on a version branch
		commit('more work')
		commit('more work')
		commit('more work')


		// now test a version branch
		let versionBranch = 'v0.1.x'
		sh('git', 'checkout', '-b', versionBranch, 'v0.1.0')
		let versionOpts = parseOpts({versionTemplate: versionBranch, doPush: 'false' })

		commit('v0.1.1')
		assertEq(getAndApply(versionOpts), [0,1,1])

		// emulate a merged PR from a version branch
		sh('git', 'checkout', 'master')
		sh('git', 'merge', '--no-edit', versionBranch)
		let mergeCommit = sh('git', 'rev-parse', 'HEAD')

		assertEq(getAndApply(opts), [1,1,0], 'next version should be based on first parent')

		// emulate a PR against master from the version branch
		sh('git', 'checkout', versionBranch)
		commit('version work')

		let clone = tempdir + '/clone'
		sh('git', 'clone', origin, clone)
		process.chdir(clone)

		// now emulate a PR against master from the version branch (i.e. pretend HEAD is an auto merge commit for a PR)
		sh('git', 'checkout', '-b', 'pr-merge')
		sh('git', 'merge', '--no-edit', 'origin/'+versionBranch)
		process.env['GITHUB_BASE_REF'] = 'master' // has v1.1.0, even though it's not in HEAD
		process.env['GITHUB_HEAD_REF'] = versionBranch // has v0.1.0 but we should ignore this
		// dumpState()
		assertEq(getAndApply(opts), [1,2,0], 'next version should come from PR target')

	} finally {
		sh('rm', '-rf', tempdir)
	}
}
