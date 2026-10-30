const crypto = require('crypto');
const TaskManager = require('../../../libs/TaskManager');
const taskNew = require('../../../libs/taskNew');
const logger = require('../../../libs/logger');

const options = JSON.parse(process.argv[2]);
const lookups = [];
let generatedCalls = 0;
const randomUUID = crypto.randomUUID;

crypto.randomUUID = () => {
    generatedCalls++;
    return options.generatedId || randomUUID();
};

TaskManager.singleton = () => ({
    find: (id) => {
        lookups.push(id);
        return id === options.existingId ? { uuid: id } : undefined;
    }
});

const suppliedIds = options.suppliedIds || Array(options.count || 1).fill(undefined);
const assignments = suppliedIds.map(suppliedId => {
    const req = { get: (header) => header === 'set-uuid' ? suppliedId : undefined };
    const errors = [];
    let nextCalls = 0;
    taskNew.assignUUID(req, { json: (body) => errors.push(body) }, () => nextCalls++);
    return { id: req.id, nextCalls, errors };
});

logger.close();
process.stdout.write(JSON.stringify({ assignments, lookups, generatedCalls }));
