import { test, expect } from '@playwright/test';
import * as fs from 'fs';

// Assumed custom libraries
const solaceClient = {
    subscribe: async (destination: string, timeout: number) => {
        console.log(`Subscribing to ${destination} with timeout ${timeout}`);
        // Simulate receiving a message after a delay
        await new Promise(resolve => setTimeout(resolve, 1000));
        return [JSON.parse(fs.readFileSync('test-data_4.json', 'utf8'))]; // Return the contents of the test-data file
    },
    publish: async (destination: string, message: any) => {
        console.log(`Publishing to ${destination} with message ${JSON.stringify(message)}`);
    }
};
const dbClient = {
    query: async (query: string) => {
        console.log(`Executing DB query: ${query}`);
        // Simulate a database result
        return [{
            DEBIT_AMOUNT: "150.75",
            CREDIT_AMOUNT: "150.75"
        }];
    }
};
const mongoClient = {
    find: async (collection: string, filter: any) => {
        console.log(`Finding in Mongo collection ${collection} with filter ${JSON.stringify(filter)}`);
        // Simulate a MongoDB result
        return [{
            reqId: filter.reqId,
            source: "InboundAccountingService",
            eventcode: "EVT.CoreSvc.Status.Accounting.102"
        }];
    }
};
const dataGenerator = {
    newPuId: () => 'PUID_' + Math.random().toString(36).substring(2, 15),
    newTxId: () => 'TXID_' + Math.random().toString(36).substring(2, 15),
    newProcDate: (format: string) => {
        const today = new Date();
        const yyyy = today.getFullYear();
        let mm = today.getMonth() + 1; // Months start at 0!
        let dd = today.getDate();

        if (dd < 10) dd = 0 + dd;
        if (mm < 10) mm = 0 + mm;

        return yyyy + '-' + mm + '-' + dd;
    }
};

function populateTemplate(templateString: string, payloadObject: any): string {
    let populatedString = templateString;
    for (const key in payloadObject) {
        if (payloadObject.hasOwnProperty(key)) {
            const placeholder = new RegExp(`\\\$\\\{\\s*${key}\\\s*\\\}`, 'g');
            populatedString = populatedString.replace(placeholder, payloadObject[key]);
        }
    }
    return populatedString;
}

const testData = JSON.parse(fs.readFileSync('test-data.json', 'utf8'));

function scrubIgnoredFields(actual: any, expected: any): { scrubbedActual: any, scrubbedExpected: any } {
    const clonedActual = JSON.parse(JSON.stringify(actual));
    const clonedExpected = JSON.parse(JSON.stringify(expected));

    function traverse(actualObj: any, expectedObj: any) {
        for (const key in expectedObj) {
            if (expectedObj.hasOwnProperty(key)) {
                if (expectedObj[key] === "@Ignore@") {
                    delete actualObj[key];
                    delete expectedObj[key];
                } else if (typeof expectedObj[key] === 'object' && expectedObj[key] !== null) {
                    if (actualObj && actualObj[key]) {
                        traverse(actualObj[key], expectedObj[key]);
                    }
                }
            }
        }
    }

    traverse(clonedActual, clonedExpected);
    return { scrubbedActual: clonedActual, scrubbedExpected: clonedExpected };
}

test(testData.testMetadata.testName, async () => {
    const dynamicData = { puId: dataGenerator.newPuId(), txId: dataGenerator.newTxId(), procDate: dataGenerator.newProcDate("YYYY-MM-DD"), utcDateTime: new Date().toISOString() };
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
    // Add cleanup logic here if needed (e.g., close connections)
});