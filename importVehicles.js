
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const db = require('./db');

const CSV_PATH = path.join(__dirname, 'CarRentalData.csv');

// Example conversion rate only; adjust if needed.
const USD_TO_INR = 85;

async function importVehicles() {
    try {
        console.log('Reading vehicle dataset...');

        const rows = [];

        await new Promise((resolve, reject) => {
            fs.createReadStream(CSV_PATH)
                .pipe(csv())
                .on('data', row => rows.push(row))
                .on('end', resolve)
                .on('error', reject);
        });

        console.log(`CSV records found: ${rows.length}`);

        const vehicles = rows
            .filter(row =>
                row['vehicle.make'] &&
                row['vehicle.model'] &&
                Number(row['vehicle.year']) > 0 &&
                Number(row['rate.daily']) > 0
            )
            .map((row, index) => [
                `CSV-${String(index + 1).padStart(6, '0')}`,
                row['vehicle.make'].trim(),
                row['vehicle.model'].trim(),
                Number(row['vehicle.year']),
                Math.round(
                    Number(row['rate.daily']) * USD_TO_INR * 100
                ) / 100,
                'Available'
            ]);

        console.log(`Valid vehicles: ${vehicles.length}`);

        let inserted = 0;

        // Insert in batches to avoid one huge SQL query.
        for (let i = 0; i < vehicles.length; i += 250) {
            const batch = vehicles.slice(i, i + 250);

            const [result] = await db.query(
                `INSERT IGNORE INTO vehicles
                (registration_number, make, model,
                 manufacture_year, rental_rate_per_day, status)
                VALUES ?`,
                [batch]
            );

            inserted += result.affectedRows;
            console.log(
                `Processed ${Math.min(i + 250, vehicles.length)} / ${vehicles.length}`
            );
        }

        console.log(`Import completed. New vehicles added: ${inserted}`);
        console.log('Existing vehicle records have been preserved.');

    } catch (error) {
        console.error('Import failed:', error.message);
        process.exitCode = 1;
    } finally {
        if (typeof db.end === 'function') {
            await db.end();
        }
    }
}

importVehicles();
