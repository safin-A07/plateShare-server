require("dotenv").config();
const express = require("express");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");

const app = express();
const port = process.env.PORT || 3000;
app.use(express.json());
const cors = require("cors");
app.use(cors());

const decodedKey = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString('utf8');
const serviceAccount = JSON.parse(decodedKey);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.nbmsclf.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
});

let usersCollection;
let donationsCollection;
let restaurantRequestsCollection;
let reviewsCollection;
let requestsCollection;

async function run() {
  try {
    // await client.connect();
    console.log("✅ Connected to MongoDB");

    const db = client.db("plateShare");
    usersCollection = db.collection("usersCollection");
    donationsCollection = db.collection("donations");
    restaurantRequestsCollection = db.collection("restaurantRequests");
    reviewsCollection = db.collection("reviews");
    requestsCollection = db.collection("requests");
    // ✅ Verify Firebase token middleware
    const verifyFBToken = async (req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).send({ message: 'unauthorized access' });
      }
      const token = authHeader.split(' ')[1];
      if (!token) {
        return res.status(401).send({ message: 'unauthorized access' });
      }

      try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.decoded = decoded;
        next();
      } catch (error) {
        return res.status(403).send({ message: 'forbidden access' });
      }
    };

    // ✅ Verify Admin middleware
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      if (!user || user.role !== 'admin') {
        return res.status(403).send({ message: 'forbidden access' });
      }
      next();
    };

    // ✅ Verify Charity middleware
    const verifyCharity = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      if (!user || user.role !== 'charity') {
        return res.status(403).send({ message: 'forbidden access' });
      }
      next();
    };
    // ✅ Verify restaurant middleware
    const verifyRestaurant = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      if (!user || user.role !== 'restaurant') {
        return res.status(403).send({ message: 'forbidden access' });
      }
      next();
    };


    // ✅ Register user
    app.post("/users", async (req, res) => {
      const { name, email, profileLink } = req.body;

      if (!name || !email) {
        return res.status(400).json({ message: "Name and Email are required" });
      }

      const existingUser = await usersCollection.findOne({ email });
      if (existingUser) {
        return res.status(400).json({ message: "User already exists" });
      }

      const newUser = {
        name,
        email,
        profileLink: profileLink || null,
        role: "user", // default role
        createdAt: new Date(),
      };

      const result = await usersCollection.insertOne(newUser);
      res.status(201).json({ message: "User registered successfully", userId: result.insertedId });
    });

    // ✅ Get all users
    app.get("/users", verifyFBToken, verifyAdmin, verifyCharity, async (req, res) => {
      const users = await usersCollection.find().toArray();
      res.json(users);
    });

    // Fetch logged-in charity profile
    // Fetch all charity users (admin or logged-in users can access)
    app.get("/users/charities", verifyFBToken, async (req, res) => {
      try {
        const charityUsers = await usersCollection
          .find({ role: "charity" })
          .toArray();
        res.json(charityUsers);
      } catch (err) {
        console.error("Failed to fetch charities:", err);
        res.status(500).json({ message: "Failed to fetch charities" });
      }
    });



    // ✅ Single user by email (keep after search)
    app.get("/users/search", verifyFBToken, verifyAdmin, async (req, res) => {
      const { q } = req.query;
      if (!q) return res.json([]);

      try {
        const users = await usersCollection.find({
          $or: [
            { email: { $regex: q, $options: "i" } },
            { name: { $regex: q, $options: "i" } }
          ]
        }).toArray();

        res.json(users);
      } catch (err) {
        console.error("Search error:", err);
        res.status(500).json({ message: "Search failed" });
      }
    });

    // ✅ Allow any authenticated user to get their own profile
    app.get("/users/:email", verifyFBToken, async (req, res) => {
      // console.log("Decoded token:", req.headers);
      const email = req.params.email;

      // Make sure user can only fetch their own data
      if (req.decoded.email !== email) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const user = await usersCollection.findOne({ email });

      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      res.json(user);
    });



    // 1) Create PaymentIntent (fixed $25 => 2500 cents)
    app.post('/create-payment-intent', verifyFBToken, async (req, res) => {
      try {
        const { amount, email, purpose } = req.body; // amount in cents
        const paymentIntent = await stripe.paymentIntents.create({
          amount,
          currency: 'usd',
          description: `PlateShare: ${purpose || 'charity-role'}`,
          metadata: { email, purpose: purpose || 'charity-role' },
          automatic_payment_methods: { enabled: true },
        });
        res.send({ clientSecret: paymentIntent.client_secret });
      } catch (e) {
        res.status(400).send({ message: e.message });
      }
    });

    // after your existing role-requests endpoints:
    app.get('/charity-requests/status', verifyFBToken, async (req, res) => {
      const email = req.query.email;
      const existing = await db.collection('roleRequests')
        .findOne({ email, status: { $in: ['Pending', 'Approved'] } });
      res.send({ status: existing?.status || null });
    });

    app.post('/charity-requests', verifyFBToken, async (req, res) => {
      // simply forward to the same logic as /role-requests
      const { email, name, organization, mission, amount, transactionId } = req.body;
      const exists = await db.collection('roleRequests')
        .findOne({ email, status: { $in: ['Pending', 'Approved'] } });
      if (exists) return res.status(400).send({ message: 'You already have a pending or approved request.' });

      const doc = { email, name, organization, mission, amount, transactionId, status: 'Pending', createdAt: new Date() };
      const result = await db.collection('roleRequests').insertOne(doc);
      res.send({ insertedId: result.insertedId });
    });

    // 2) Check existing request status
    app.get('/role-requests/status', verifyFBToken, async (req, res) => {
      const email = req.query.email;
      const existing = await db.collection('roleRequests').findOne({ email, status: { $in: ['Pending', 'Approved'] } });
      res.send({ status: existing?.status || null });
    });

    // 3) Save role request (status: Pending)
    app.post('/role-requests', verifyFBToken, async (req, res) => {
      const { email, name, organization, mission, amount, transactionId } = req.body;

      // block duplicates if already pending/approved
      const exists = await db.collection('roleRequests').findOne({ email, status: { $in: ['Pending', 'Approved'] } });
      if (exists) return res.status(400).send({ message: 'You already have a pending or approved request.' });

      const doc = {
        email, name, organization, mission,
        amount,
        transactionId,
        status: 'Pending',
        createdAt: new Date()
      };
      const result = await db.collection('roleRequests').insertOne(doc);
      res.send({ insertedId: result.insertedId });
    });

    // 4) Save transaction
    app.post('/transactions', verifyFBToken, async (req, res) => {
      const { transactionId, email, amount, purpose } = req.body;
      const doc = { transactionId, email, amount, purpose, createdAt: new Date() };
      const result = await db.collection('transactions').insertOne(doc);
      res.send({ insertedId: result.insertedId });
    });



    app.get("/users/:id/role", async (req, res) => {
      const { id } = req.params;
      const user = await usersCollection.findOne({ _id: new ObjectId(id) });

      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      res.json(user);
    });
    // admin can update without payment the role of the user 
    app.patch("/users/:id/role", verifyFBToken, verifyAdmin, async (req, res) => {
      const { id } = req.params;
      const { role } = req.body; // "admin" | "restaurant" | "charity"

      const result = await usersCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { role } }
      );
      res.json(result);
    });

    // ============================
    //  ROLE REQUESTS MANAGEMENT
    // ============================

    // Get all role requests (admin only)
    app.get("/role-requests", verifyFBToken, verifyAdmin, async (req, res) => {   // ✅ NEW
      try {
        const requests = await db.collection("roleRequests")
          .find()
          .sort({ createdAt: -1 })
          .toArray();
        res.json(requests);
      } catch (err) {
        console.error("Error fetching role requests:", err);
        res.status(500).json({ message: "Failed to fetch role requests" });
      }

    });

    // Get all requests made by a specific charity
    app.get("/role-requests/my-requests", verifyFBToken, verifyCharity, async (req, res) => {
      try {
        const email = req.decoded.email;
        const requests = await db.collection("roleRequests")
          .find({ email })
          .sort({ createdAt: -1 })
          .toArray();
        res.json(requests);
      } catch (err) {
        console.error("Error fetching requests:", err);
        res.status(500).json({ message: "Failed to fetch requests" });
      }
    });

    // Delete a request (only if Pending)
    app.delete("/role-requests/:id", verifyFBToken, async (req, res) => {
      try {
        const email = req.decoded.email;
        const { id } = req.params;

        const request = await db.collection("roleRequests").findOne({ _id: new ObjectId(id) });

        if (!request) return res.status(404).json({ message: "Request not found" });
        if (request.email !== email) return res.status(403).json({ message: "Forbidden" });
        if (request.status !== "Pending") return res.status(400).json({ message: "Only pending requests can be deleted" });

        const result = await db.collection("roleRequests").deleteOne({ _id: new ObjectId(id) });
        res.json({ message: "Request deleted successfully", deletedCount: result.deletedCount });
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Failed to delete request" });
      }
    });


    // Approve or Reject role request (admin only)
    app.patch("/role-requests/:id", verifyFBToken, verifyAdmin, async (req, res) => {  // ✅ NEW
      try {
        const { id } = req.params;
        const { status } = req.body; // "Approved" | "Rejected"

        if (!["Approved", "Rejected"].includes(status)) {
          return res.status(400).json({ message: "Invalid status" });
        }

        // Update request status
        const result = await db.collection("roleRequests").updateOne(
          { _id: new ObjectId(id) },
          { $set: { status } }
        );

        // If approved → update user role to "charity"
        if (status === "Approved") {
          const roleRequest = await db.collection("roleRequests").findOne({ _id: new ObjectId(id) });
          if (roleRequest?.email) {
            await usersCollection.updateOne(
              { email: roleRequest.email },
              { $set: { role: "charity" } }
            );
          }
        }

        res.json({ message: `Request ${status}`, result });
      } catch (err) {
        console.error("Error updating role request:", err);
        res.status(500).json({ message: "Failed to update request" });
      }
    });


    // restaurant role requests



    //  become a restaurant (user can request, admin approve/reject)
    app.post("/restaurant-requests", verifyFBToken, async (req, res) => {
      try {
        const {
          restaurantName,
          about,
          location,
          openingTime,
          closingTime,
          foodType,
          imageUrl,
          ownerEmail,
          restaurantEmail,
          phone,
        } = req.body;

        if (!restaurantName || !about || !location || !openingTime || !closingTime || !foodType || !restaurantEmail || !phone || !ownerEmail) {
          return res.status(400).json({ message: "All required fields must be provided" });
        }

        // Check if already has a pending/approved request
        const exists = await restaurantRequestsCollection.findOne({
          ownerEmail,
          status: { $in: ["Pending", "Approved"] },
        });
        if (exists) {
          return res.status(400).json({ message: "You already have a pending or approved request" });
        }

        const newRequest = {
          restaurantName,
          about,
          location,
          openingTime,
          closingTime,
          foodType,
          imageUrl: imageUrl || null,
          ownerEmail,
          restaurantEmail,
          phone,
          status: "Pending",
          createdAt: new Date(),
        };

        const result = await restaurantRequestsCollection.insertOne(newRequest);
        res.status(201).json({
          message: "Restaurant request submitted successfully",
          requestId: result.insertedId,
        });
      } catch (err) {
        console.error("❌ Error creating restaurant request:", err);
        res.status(500).json({ message: "Failed to submit request" });
      }
    });
    //  Get all restaurant requests (Admin only)


    app.get("/restaurant-requests", verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const requests = await restaurantRequestsCollection
          .find()
          .sort({ createdAt: -1 })
          .toArray();

        res.json(requests);
      } catch (err) {
        console.error("❌ Failed to fetch restaurant requests:", err);
        res.status(500).json({ message: "Failed to fetch restaurant requests" });
      }
    });


    //  Get all donations for homepage (no verifyAdmin)
    app.get("/donations", async (req, res) => {
      try {
        const donations = await donationsCollection.find().toArray();
        res.json(donations);
      } catch (err) {
        console.error("❌ Error fetching donations:", err);
        res.status(500).json({ message: "Failed to fetch donations" });
      }
    });


    //  Get all donations (Admin only)
    app.get("/donations/admin", verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const donations = await donationsCollection.find().toArray();
        res.json(donations);
      } catch (err) {
        console.error("❌ Error fetching donations:", err);
        res.status(500).json({ message: "Failed to fetch donations" });
      }
    });




    // Approve restaurant request
    app.patch("/restaurant-requests/:id", verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const { id } = req.params;

        // Update request status
        const result = await restaurantRequestsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status: "Approved" } }
        );

        // Get the updated request
        const request = await restaurantRequestsCollection.findOne({ _id: new ObjectId(id) });

        // Update user role in usersCollection if ownerEmail exists
        if (request?.ownerEmail) {
          await usersCollection.updateOne(
            { email: request.ownerEmail },
            { $set: { role: "restaurant" } }
          );
        }

        res.json({ message: "Restaurant request approved and role updated", result });
      } catch (err) {
        console.error("❌ Failed to approve request:", err);
        res.status(500).json({ message: "Failed to approve request" });
      }
    });


    // Reject restaurant request
    app.delete("/restaurant-requests/:id", verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const { id } = req.params;

        const result = await restaurantRequestsCollection.deleteOne({ _id: new ObjectId(id) });

        if (!result.deletedCount) {
          return res.status(404).json({ message: "Request not found" });
        }

        // NOTE: we do NOT update user role here → remains "user"

        res.json({ message: "Restaurant request deleted successfully" });
      } catch (err) {
        console.error("❌ Failed to delete request:", err);
        res.status(500).json({ message: "Failed to delete request" });
      }
    });


    //  Get restaurant by ownerEmail
    app.get("/restaurant-requests/owner/:email", verifyFBToken, async (req, res) => {
      try {
        const email = req.params.email;
        const restaurant = await restaurantRequestsCollection.findOne({ ownerEmail: email });

        if (!restaurant) {
          return res.status(404).json({ message: "Restaurant not found" });
        }

        res.json(restaurant);
      } catch (err) {
        console.error("❌ Error fetching restaurant by owner email:", err);
        res.status(500).json({ message: "Failed to fetch restaurant" });
      }
    });

    // ============================




    //  be a donor
    app.post("/donations", verifyFBToken, async (req, res) => {
      try {
        const {
          title,
          foodType,
          quantity,
          pickupTime,
          restaurantName,
          restaurantEmail,
          location,
          imageUrl,
        } = req.body;

        // Basic validation
        if (!title || !foodType || !quantity || !pickupTime || !restaurantName || !restaurantEmail || !location) {
          return res.status(400).json({ message: "All required fields must be provided" });
        }

        const newDonation = {
          title,
          foodType,
          quantity,
          pickupTime,
          restaurantName,
          restaurantEmail,
          location,
          imageUrl: imageUrl || null,
          status: "Pending", // default
          createdAt: new Date(),
        };

        const result = await donationsCollection.insertOne(newDonation);

        res.status(201).json({
          message: "Donation added successfully",
          donationId: result.insertedId,
          donation: newDonation,
        });
      } catch (err) {
        console.error("❌ Error adding donation:", err);
        res.status(500).json({ message: "Failed to add donation" });
      }
    });
    // get all my  donations (restaurant can see all donations)
    app.get("/donations/restaurant/:email", verifyFBToken, async (req, res) => {
      try {
        const email = req.params.email;
        const donations = await donationsCollection
          .find({ restaurantEmail: email })
          .toArray();

        res.json(donations);
      } catch (err) {
        console.error("❌ Error fetching donations:", err);
        res.status(500).json({ message: "Failed to fetch donations" });
      }
    });
    //update donation information
    app.put("/donations/:id", verifyFBToken, async (req, res) => {
      try {
        const id = req.params.id;
        const updateData = req.body;

        const result = await donationsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updateData }
        );

        res.json({ message: "Donation updated successfully", result });
      } catch (err) {
        console.error("❌ Error updating donation:", err);
        res.status(500).json({ message: "Failed to update donation" });
      }
    });
    // delete my donation
    app.delete("/donations/:id", verifyFBToken, async (req, res) => {
      try {
        const id = req.params.id;

        const result = await donationsCollection.deleteOne({
          _id: new ObjectId(id),
        });

        res.json({ message: "Donation deleted successfully", result });
      } catch (err) {
        console.error("❌ Error deleting donation:", err);
        res.status(500).json({ message: "Failed to delete donation" });
      }
    });

    //home page donations api


    // Get a single donation with its reviews
    app.get("/donations/:id", async (req, res) => {
      try {
        const id = req.params.id;

        // Find the donation
        const donation = await donationsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!donation) {
          return res.status(404).json({ message: "Donation not found" });
        }

        // Find reviews related to this donation
        const reviews = await reviewsCollection
          .find({ donationId: id })
          .toArray();

        res.json({
          donation,
          reviews,
        });
      } catch (err) {
        console.error("❌ Error fetching donation details:", err);
        res.status(500).json({ message: "Failed to fetch donation details" });
      }
    });

    // ✅ POST: Add a review
    app.post("/reviews", async (req, res) => {
      try {
        const { donationId, reviewerName, description, rating } = req.body;

        // validate input
        if (!donationId || !reviewerName || !description || !rating) {
          return res.status(400).json({ error: "All fields are required" });
        }

        const reviewDoc = {
          donationId: new ObjectId(donationId),
          reviewerName,
          description,
          rating: Number(rating),
          createdAt: new Date(),
        };

       const result = await reviewsCollection.insertOne(reviewDoc);

        res.status(201).json({
          insertedId: result.insertedId,
          ...reviewDoc,
        });
      } catch (err) {
        console.error("❌ Error saving review:", err);
        res.status(500).json({ error: "Failed to add review" });
      }
    });


    // Request for donation (charity)
    app.post("/requests", verifyFBToken, verifyCharity, async (req, res) => {
      try {
        const requestData = req.body;

        // add server-side timestamp to ensure consistency
        requestData.createdAt = new Date();
        requestData.status = "Pending";

        const result = await requestsCollection.insertOne(requestData);

        res.status(201).json({
          message: "Donation request submitted successfully",
          result,
        });
      } catch (err) {
        console.error("❌ Error submitting request:", err);
        res.status(500).json({ message: "Failed to submit request" });
      }
    });


    // Get all requests made by logged-in charity
    app.get("/requests", verifyFBToken, verifyCharity, async (req, res) => {
      try {
        const email = req.decoded.email; // logged-in charity’s email
        const requests = await requestsCollection
          .find({ charityEmail: email })
          .sort({ createdAt: -1 })
          .toArray();

        res.json(requests);
      } catch (err) {
        console.error(" Error fetching requests:", err);
        res.status(500).json({ message: "Failed to fetch requests" });
      }
    });

    // Cancel a request (only if Pending & belongs to logged-in charity)
    app.delete("/requests/:id", verifyFBToken, verifyCharity, async (req, res) => {
      try {
        const { id } = req.params;
        const email = req.decoded.email;

        const request = await requestsCollection.findOne({ _id: new ObjectId(id) });

        if (!request) {
          return res.status(404).json({ message: "Request not found" });
        }

        if (request.charityEmail !== email) {
          return res.status(403).json({ message: "Forbidden: Not your request" });
        }

        if (request.status !== "Pending") {
          return res.status(400).json({ message: "Only pending requests can be cancelled" });
        }

        const result = await requestsCollection.deleteOne({ _id: new ObjectId(id) });

        res.json({ message: "Request cancelled successfully", deletedCount: result.deletedCount });
      } catch (err) {
        console.error("❌ Error cancelling request:", err);
        res.status(500).json({ message: "Failed to cancel request" });
      }
    });

    // Get all requests for a restaurant's donations
    app.get("/restaurant/requests", verifyFBToken, verifyRestaurant, async (req, res) => {
      try {
        const email = req.decoded.email;

        const requests = await requestsCollection
          .find({ restaurantEmail: email })
          .toArray();

        res.json(requests);
      } catch (err) {
        console.error("❌ Error fetching restaurant requests:", err);
        res.status(500).json({ message: "Failed to fetch restaurant requests" });
      }
    });

    // Update request status (Accept / Reject)
    app.patch("/requests/:id", verifyFBToken, verifyRestaurant, async (req, res) => {
      try {
        const { id } = req.params;
        const { status } = req.body; // "Accepted" or "Rejected"

        const result = await requestsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status } }
        );

        res.json({ message: "Request updated", result });
      } catch (err) {
        console.error("❌ Error updating request:", err);
        res.status(500).json({ message: "Failed to update request" });
      }
    });

    // PATCH: Confirm Pickup by Charity
    // Confirm pickup (charity only)

    // Confirm pickup (update both request + donation)
    app.patch("/requests/:id/pickup", verifyFBToken, verifyCharity, async (req, res) => {
      try {
        const requestId = req.params.id;

        // 1. find the request (to get donationId)
        const request = await requestsCollection.findOne({ _id: new ObjectId(requestId) });
        if (!request) {
          return res.status(404).json({ message: "Request not found" });
        }

        // 2. update donation first
        const donationId = request.donationId;
        await donationsCollection.updateOne(
          { _id: ObjectId.isValid(donationId) ? new ObjectId(donationId) : donationId },
          { $set: { status: "Picked Up" } }
        );

        // 3. update request
        const updatedRequest = await requestsCollection.findOneAndUpdate(
          { _id: new ObjectId(requestId) },
          { $set: { status: "Picked Up" } },
          { returnDocument: "after" }
        );

        res.json({
          message: "Pickup confirmed successfully",
          request: updatedRequest.value,
        });
      } catch (err) {
        console.error("❌ Error confirming pickup:", err);
        res.status(500).json({ message: "Failed to confirm pickup" });
      }
    });

  } catch (err) {
    console.error("❌ MongoDB connection failed:", err);
  }
}

run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("🍽️ PlateShare API running...");
});

app.listen(port, () => {
  console.log(`🚀 Server listening on port ${port}`);
});
