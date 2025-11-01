import { test, expect } from '@playwright/test';
import * as fs from 'fs';

// Assume these libraries exist and are correctly configured
import { solaceClient } from './solaceClient';
import { dbClient } from './dbClient';
import { mongoClient } from './mongoClient';
import { dataGenerator } from './dataGenerator';
import { populateTemplate } from './populateTemplate';

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
                if (actualObj && typeof actualObj[key] === 'object' && actualObj[key] !== null) {
                    traverse(actualObj[key], expectedObj[key]);
                }
            }
        }
    }

    traverse(clonedActual, clonedExpected);
    return { scrubbedActual: clonedActual, scrubbedExpected: clonedExpected };
}

test(testData.testMetadata.testName, async () => {
    const dynamicData = {
        puId: dataGenerator.newPuId(),
        txId: dataGenerator.newTxId(),
        procDate: dataGenerator.newProcDate("YYYY-MM-DD"),
        utcDateTime: new Date().toISOString()
    };

    const payload = { ...testData.testTemplateData.templateParameters.static, ...dynamicData };

    const inputTemplateString = fs.readFileSync(testData.testTemplateData.templatePath, 'utf8');
    const responseTemplateString = fs.readFileSync(testData.messaging.reply.responseTemplatePath, 'utf8');

    const populatedInputRequest = JSON.parse(populateTemplate(inputTemplateString, payload));
    const populatedExpectedResponse = JSON.parse(populateTemplate(responseTemplateString, payload));

    const { messaging, databaseVerification, mongoVerification } = testData;

    const [actualResponse] = await Promise.all([
        solaceClient.subscribe(messaging.reply.destination, messaging.reply.timeout || 30000),
        solaceClient.publish(messaging.inputQueue.destination, populatedInputRequest)
    ]);

    const { scrubbedActual, scrubbedExpected } = scrubIgnoredFields(actualResponse, populatedExpectedResponse);
    expect(scrubbedActual).toEqual(scrubbedExpected);

    await expect.poll(async () => {
        for (const verification of databaseVerification) {
            const populatedQuery = populateTemplate(verification.query, payload);
            const dbResult = await dbClient.query(populatedQuery);
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
            const mongoResult = await mongoClient.find(verification.collection, populatedFilter);
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
    // Close any open connections after all tests have completed
    await dbClient.close();
    await solaceClient.close();
});