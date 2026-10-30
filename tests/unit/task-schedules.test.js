const { test, expect, afterEach } = require('bun:test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const schedule = require('node-schedule');

const root = path.join(__dirname, '..', '..');
const source = fs.readFileSync(path.join(root, 'libs', 'TaskManager.js'), 'utf8');
const jobs = [];

afterEach(() => {
    for (const job of jobs.splice(0)) job.cancel();
});

function initializeManager(maxRuntime) {
    const registered = [];
    const sandbox = {
        module: { exports: {} },
        require: dependency => {
            const replacements = {
                '../config': {
                    maxRuntime,
                    cleanupTasksAfter: 2880,
                    cleanupUploadsAfter: 2880,
                    parallelQueueProcessing: 2
                },
                './logger': { info() {}, debug() {}, warn() {}, error() {} },
                './Task': {},
                './Directories': { data: 'data', tmp: 'tmp' },
                './ProgressReceiver': class {
                    addListener() {}
                },
                './statusCodes': require(path.join(root, 'libs', 'statusCodes')),
                fs: {
                    readFile: (filename, callback) => queueMicrotask(() => callback(new Error('No saved tasks'))),
                    readdir: (directory, callback) => queueMicrotask(() => callback(null, []))
                },
                'node-schedule': {
                    scheduleJob: (expression, callback) => {
                        const job = schedule.scheduleJob(expression, callback);
                        jobs.push(job);
                        registered.push({ expression, job });
                        return job;
                    }
                }
            };
            return Object.hasOwn(replacements, dependency) ? replacements[dependency] : require(dependency);
        }
    };
    vm.runInNewContext(source, sandbox, { filename: 'TaskManager.js' });
    return new Promise((resolve, reject) => {
        sandbox.module.exports.initialize(error => {
            if (error) reject(error);
            else resolve({ manager: sandbox.module.exports.singleton(), registered });
        });
    });
}

test('pins the upgraded scheduler', () => {
    const manifest = require(path.join(root, 'package.json'));
    expect(manifest.dependencies['node-schedule']).toBe('2.1.2');
    expect(require('node-schedule/package.json').version).toBe('2.1.2');
});

test('runs task cleanup, persistence and upload cleanup every hour', async () => {
    const { manager, registered } = await initializeManager(0);
    expect(registered.map(entry => entry.expression)).toEqual(['0 * * * *']);
    const calls = [];
    manager.removeOldTasks = () => calls.push('tasks');
    manager.dumpTaskList = () => calls.push('dump');
    manager.removeStaleUploads = () => calls.push('uploads');
    registered[0].job.invoke();
    expect(calls).toEqual(['tasks', 'dump', 'uploads']);
    expect(registered[0].job.nextInvocation().getMinutes()).toBe(0);
});

test('checks task timeouts every minute only when maxRuntime is enabled', async () => {
    const { manager, registered } = await initializeManager(5);
    expect(registered.map(entry => entry.expression)).toEqual(['0 * * * *', '* * * * *']);
    let checks = 0;
    manager.checkTimeouts = () => checks++;
    registered[1].job.invoke();
    expect(checks).toBe(1);
    const nextInvocation = registered[1].job.nextInvocation().getTime();
    expect(nextInvocation).toBeGreaterThan(Date.now());
    expect(nextInvocation - Date.now()).toBeLessThanOrEqual(60000);
});

test('scheduled jobs can be canceled without leaving pending invocations', async () => {
    const { registered } = await initializeManager(5);
    for (const { job } of registered) {
        expect(job.cancel()).toBe(true);
        expect(job.nextInvocation()).toBeNull();
        expect(schedule.scheduledJobs[job.name]).toBeUndefined();
    }
});
