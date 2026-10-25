
const path = require("path");

require("dotenv").config({
    path: path.join(__dirname, ".env"),
});

const fs = require("fs");
const csv = require("csv-parser");
const mysql = require("mysql2/promise");

const CSV_FILE = path.join(__dirname, "CarRentalData.csv");
const USD_TO_INR = 85;
const MAX_VEHICLES = 200;

async function main() {
    let connection;
    let transactionStarted = false;

    try {
        // 1. Validate configuration
        if (!process.env.DB_PASSWORD) {
            throw new Error(
                "DB_PASSWORD is missing from src/.env"
            );
        }

        if (!process.env.DB_NAME) {
            throw new Error(
                "DB_NAME is missing from src/.env"
            );
        }

        if (!fs.existsSync(CSV_FILE)) {
            throw new Error(
                `CSV file not found: ${CSV_FILE}`
            );
        }

        // 2. Connect to MySQL
        connection = await mysql.createConnection({
            host: process.env.DB_HOST || "localhost",
            user: process.env.DB_USER || "root",
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
        });

        console.log("Connected to MySQL.");
        console.log(`Database: ${process.env.DB_NAME}`);

        // 3. Read the first 200 CSV records
        const rows = [];

        await new Promise((resolve, reject) => {
            fs.createReadStream(CSV_FILE)
                .pipe(csv())
                .on("data", (row) => {
                    if (rows.length < MAX_VEHICLES) {
                        rows.push(row);
                    }
                })
                .on("end", resolve)
                .on("error", reject);
        });

        console.log(`CSV records read: ${rows.length}`);

        if (rows.length !== MAX_VEHICLES) {
            throw new Error(
                `Expected ${MAX_VEHICLES} records, found ${rows.length}.`
            );
        }

        // 4. Check required columns
        const requiredColumns = [
            "fuelType",
            "rating",
            "renterTripsTaken",
            "reviewCount",
            "location.city",
            "location.country",
            "location.latitude",
            "location.longitude",
            "location.state",
            "owner.id",
            "rate.daily",
            "vehicle.make",
            "vehicle.model",
            "vehicle.type",
            "vehicle.year",
        ];

        for (const column of requiredColumns) {
            if (!Object.prototype.hasOwnProperty.call(rows[0], column)) {
                throw new Error(
                    `CSV column missing: ${column}`
                );
            }
        }

        // 5. Validate all records before modifying the database
        const vehicles = rows.map((row, index) => {
            const make = (row["vehicle.make"] || "").trim();
            const model = (row["vehicle.model"] || "").trim();
            const year = Number(row["vehicle.year"]);
            const rateUSD = Number(row["rate.daily"]);

            const ratingText = (row.rating || "").trim();
            const rating = ratingText === ""
                ? null
                : Number(ratingText);

            const trips = Number(row.renterTripsTaken || 0);
            const reviews = Number(row.reviewCount || 0);

            if (
                !make ||
                !model ||
                !Number.isInteger(year) ||
                year < 1900 ||
                year > new Date().getFullYear() + 1 ||
                !Number.isFinite(rateUSD) ||
                rateUSD <= 0 ||
                (rating !== null &&
                    (!Number.isFinite(rating) ||
                     rating < 0 || rating > 5)) ||
                !Number.isInteger(trips) ||
                trips < 0 ||
                !Number.isInteger(reviews) ||
                reviews < 0
            ) {
                throw new Error(
                    `Invalid vehicle data at CSV row ${index + 2}.`
                );
            }

            const latitudeText =
                (row["location.latitude"] || "").trim();
            const longitudeText =
                (row["location.longitude"] || "").trim();

            const latitude = latitudeText === ""
                ? null
                : Number(latitudeText);

            const longitude = longitudeText === ""
                ? null
                : Number(longitudeText);

            if (
                (latitude !== null &&
                    (!Number.isFinite(latitude) ||
                     latitude < -90 || latitude > 90)) ||
                (longitude !== null &&
                    (!Number.isFinite(longitude) ||
                     longitude < -180 || longitude > 180))
            ) {
                throw new Error(
                    `Invalid coordinates at CSV row ${index + 2}.`
                );
            }

            const ownerText = (row["owner.id"] || "").trim();
            const ownerId = ownerText === ""
                ? null
                : Number(ownerText);

            if (
                ownerId !== null &&
                (!Number.isSafeInteger(ownerId) || ownerId < 0)
            ) {
                throw new Error(
                    `Invalid owner ID at CSV row ${index + 2}.`
                );
            }

            return {
                registration: `CSV-${String(index + 1).padStart(6, "0")}`,
                make,
                model,
                year,
                rateINR: Math.round(rateUSD * USD_TO_INR * 100) / 100,
                fuelType: row.fuelType || null,
                rating,
                trips,
                reviews,
                city: row["location.city"] || null,
                country: row["location.country"] || null,
                latitude,
                longitude,
                state: row["location.state"] || null,
                ownerId,
                vehicleType: row["vehicle.type"] || null,
            };
        });

        // 6. Ensure the expected schema exists
        const [columns] = await connection.execute(
            "SHOW COLUMNS FROM vehicles"
        );

        const columnNames = new Set(
            columns.map((column) => column.Field)
        );

        const requiredDatabaseColumns = [
            "registration_number",
            "make",
            "model",
            "manufacture_year",
            "rental_rate_per_day",
            "status",
            "dataset_source",
            "fuel_type",
            "rating",
            "renter_trips_taken",
            "review_count",
            "city",
            "country",
            "latitude",
            "longitude",
            "state",
            "owner_id",
            "vehicle_type",
        ];

        const missingColumns = requiredDatabaseColumns.filter(
            (column) => !columnNames.has(column)
        );

        if (missingColumns.length > 0) {
            throw new Error(
                "Missing vehicles table columns: " +
                missingColumns.join(", ") +
                ". Check your database schema before importing."
            );
        }

        // 7. Import in a transaction
        await connection.beginTransaction();
        transactionStarted = true;

        const insertSQL = `
            INSERT INTO vehicles (
                registration_number,
                make,
                model,
                manufacture_year,
                rental_rate_per_day,
                status,
                dataset_source,
                fuel_type,
                rating,
                renter_trips_taken,
                review_count,
                city,
                country,
                latitude,
                longitude,
                state,
                owner_id,
                vehicle_type
            )
            VALUES (
                ?, ?, ?, ?, ?, 'Available', 'CSV200',
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            )
            ON DUPLICATE KEY UPDATE
                make = VALUES(make),
                model = VALUES(model),
                manufacture_year = VALUES(manufacture_year),
                rental_rate_per_day = VALUES(rental_rate_per_day),
                dataset_source = 'CSV200',
                fuel_type = VALUES(fuel_type),
                rating = VALUES(rating),
                renter_trips_taken = VALUES(renter_trips_taken),
                review_count = VALUES(review_count),
                city = VALUES(city),
                country = VALUES(country),
                latitude = VALUES(latitude),
                longitude = VALUES(longitude),
                state = VALUES(state),
                owner_id = VALUES(owner_id),
                vehicle_type = VALUES(vehicle_type)
        `;

        for (const vehicle of vehicles) {
            await connection.execute(insertSQL, [
                vehicle.registration,
                vehicle.make,
                vehicle.model,
                vehicle.year,
                vehicle.rateINR,
                vehicle.fuelType,
                vehicle.rating,
                vehicle.trips,
                vehicle.reviews,
                vehicle.city,
                vehicle.country,
                vehicle.latitude,
                vehicle.longitude,
                vehicle.state,
                vehicle.ownerId,
                vehicle.vehicleType,
            ]);
        }

        // 8. Verify before committing
        const [verification] = await connection.execute(
            `SELECT COUNT(*) AS total
             FROM vehicles
             WHERE dataset_source = 'CSV200'
               AND registration_number LIKE 'CSV-%'`
        );

        const importedCount = Number(verification[0].total);

        if (importedCount !== MAX_VEHICLES) {
            throw new Error(
                `Verification failed: expected 200 CSV vehicles, found ${importedCount}.`
            );
        }

        await connection.commit();
        transactionStarted = false;

        console.log("Import successful!");
        console.log(`CSV200 vehicles verified: ${importedCount}`);
        console.log("Existing non-CSV vehicles were preserved.");
        console.log(
            `Daily rental prices converted using 1 USD = ${USD_TO_INR} INR.`
        );

    } catch (error) {
        if (connection && transactionStarted) {
            await connection.rollback();
        }

        console.error("Import failed:", error.message);
        process.exitCode = 1;

    } finally {
        if (connection) {
            await connection.end();
        }
    }
}

main();
