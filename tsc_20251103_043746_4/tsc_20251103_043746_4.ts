import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import { SolaceClient } from './solaceClient';
import { DBClient } from './dbClient';
import { MongoClient } from './mongoClient';
import { DataGenerator } from './dataGenerator';
import { populateTemplate } from './templateHelper';

const testData = JSON.parse(fs.readFileSync('test-data.json', 'utf8'));

function scrubIgnoredFields(actual: any, expected: any): { scrubbedActual: any; scrubbedExpected: any } {
    const clonedActual = JSON.parse(JSON.stringify(actual));
    const clonedExpected = JSON.parse(JSON.stringify(expected));

    function traverse(actualObj: any, expectedObj: any) {
        for (const key in expectedObj) {
            if (expectedObj[key] === "@Ignore@") {
                delete actualObj[key];
                delete expectedObj[key];
            } else if (typeof expectedObj[key] === 'object' && expectedObj[key] !== null) {
                traverse(actualObj[key], expectedObj[key]);
            }
        }
    }

    traverse(clonedActual, clonedExpected);
    return { scrubbedActual: clonedActual, scrubbedExpected: clonedExpected };
}

test(testData.testMetadata.testName, async () => {
    const dynamicData = {
        puId: DataGenerator.newPuId(),
        txId: DataGenerator.newTxId(),
        procDate: DataGenerator.newProcDate("YYYY-MM-DD"),
        utcDateTime: new Date().toISOString()
    };

    const payload = { ...testData.testTemplateData.templateParameters.static, ...dynamicData };

    const inputTemplateString = fs.readFileSync(testData.testTemplateData.templatePath, 'utf8');
    const responseTemplateString = fs.readFileSync(testData.messaging.reply.responseTemplatePath, 'utf8');

    const populatedInputRequest = JSON.parse(populateTemplate(inputTemplateString, payload));
    const populatedExpectedResponse = JSON.parse(populateTemplate(responseTemplateString, payload));

    const { messaging, databaseVerification, mongoVerification } = testData;

    const [actualResponse] = await Promise.all([
        SolaceClient.subscribe(messaging.reply.destination, messaging.reply.timeout || 30000),
        SolaceClient.publish(messaging.inputQueue.destination, populatedInputRequest)
    ]);

    const { scrubbedActual, scrubbedExpected } = scrubIgnoredFields(actualResponse, populatedExpectedResponse);
    expect(scrubbedActual).toEqual(scrubbedExpected);

    await expect.poll(async () => {
        for (const verification of databaseVerification) {
            const populatedQuery = populateTemplate(verification.query, payload);
            const dbResult = await DBClient.query(populatedQuery);
            if (dbResult.length === 0) return false;
            for (const item of verification.verification) {
                const expectedValue = populateTemplate(item.value, payload);
                if (dbResult[0][item.field].toString() !== expectedValue) return false;
            }
        }
        return true;
    }, { message: 'Database verification failed', timeout: 10000 }).toBe(true);

    await expect.poll(async () => {
        for (const verification of mongoVerification) {
            const populatedFilter = JSON.parse(populateTemplate(JSON.stringify(verification.filter), payload));
            const mongoResult = await MongoClient.find(verification.collection, populatedFilter);
            if (mongoResult.length !== verification.expectedCount.value) return false;
            for (const item of verification.verification) {
                const expectedValue = populateTemplate(item.value, payload);
                if (mongoResult[0][item.field].toString() !== expectedValue) return false;
            }
        }
        return true;
    }, { message: 'Mongo verification failed', timeout: 10000 }).toBe(true);
});

test.afterAll(async () => {
    // Optionally close connections here
    // await dbClient.close();
    // await solaceClient.close();
});