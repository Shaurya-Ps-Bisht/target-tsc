import { test, expect } from '@playwright/test';
import * as fs from 'fs';

// Assume these libraries exist
const solaceClient = {
    publish: async (destination: string, message: any) => {
        console.log(`Publishing to ${destination}: ${JSON.stringify(message)}`);
        return Promise.resolve();
    },
    subscribe: async (destination: string, timeout: number) => {
        console.log(`Subscribing to ${destination} with timeout ${timeout}`);
        // Simulate a received message
        return Promise.resolve(JSON.parse(fs.readFileSync('test-data_3.json', 'utf8')));
    },
    close: async () => {
        console.log('Solace client closed');
    }
};
const dbClient = {
    query: async (query: string) => {
        console.log(`Executing DB query: ${query}`);
        // Simulate a database result
        return Promise.resolve([{
            PU_ID: 'dummyPuId',
            ACTION_CODE: 'DebitClient_CreditClearing',
            DEBIT_ACCOUNT_ID: 'ACME-CORP-DDA',
            DEBIT_AMOUNT: '750000.00',
            CREDIT_ACCOUNT_ID: 'PAYROLL-CLR-SUSP',
            CREDIT_AMOUNT: '750000.00'
        }]);
    },
    close: async () => {
        console.log('DB client closed');
    }
};
const mongoClient = {
    find: async (collection: string, filter: any) => {
        console.log(`Finding in Mongo collection ${collection} with filter: ${JSON.stringify(filter)}`);
        // Simulate a MongoDB result
        return Promise.resolve([{
            reqId: 'dummyTxId',
            source: 'xyzInwardAccountingService',
            eventcode: 'P.xyz.STS.CP_PAE.102'
        }]);
    },
    close: async () => {
        console.log('Mongo client closed');
    }
};
const dataGenerator = {
    newPuId: () => 'PU' + Date.now(),
    newTxId: () => 'TX' + Date.now(),
    newProcDate: (format: string) => {
        const today = new Date();
        const year = today.getFullYear();
        const month = String(today.getMonth() + 1).padStart(2, '0');
        const day = String(today.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }
};

function populateTemplate(templateString: string, payloadObject: any): string {
    let populatedString = templateString;
    for (const key in payloadObject) {
        if (payloadObject.hasOwnProperty(key)) {
            const placeholder = new RegExp(`\\\$\\\{\\s*${key}\\s*\\\}`,"g");
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
    await dbClient.close();
    await solaceClient.close();
    await mongoClient.close();
});